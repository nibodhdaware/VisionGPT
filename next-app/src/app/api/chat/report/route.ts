import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hashId, now } from "@/lib/utils";
import twilio from "twilio";

const RATE_LIMIT_SEC = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { session_id } = body;
    if (!session_id) {
      return NextResponse.json({ error: "session_id required" }, { status: 400 });
    }

    // Rate limit
    const recent = await sql`
      SELECT created_at FROM incidents
      WHERE session_id = ${session_id} AND role = 'report' AND created_at > ${new Date(Date.now() - RATE_LIMIT_SEC * 1000).toISOString()}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (recent.length > 0) {
      return NextResponse.json({ error: "rate_limited", message: "Please wait before reporting again" }, { status: 429 });
    }

    // Get latest analysis
    const rows = await sql`
      SELECT content FROM incidents
      WHERE session_id = ${session_id} AND role = 'assistant'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: "no_analysis" }, { status: 400 });
    }

    let analysis: any;
    try {
      analysis = JSON.parse(rows[0].content);
    } catch {
      return NextResponse.json({ error: "invalid_analysis" }, { status: 400 });
    }

    const reportId = hashId(session_id, now(), "report");

    // Attempt WhatsApp
    let whatsappSent = false;
    let whatsappReason = "not_requested";
    const enabled = process.env.ENABLE_WHATSAPP_NOTIFY === "true";
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
    const authorityPhone = process.env.AUTHORITY_WHATSAPP_TO;

    if (enabled && accountSid && authToken && twilioFrom && authorityPhone) {
      try {
        const client = twilio(accountSid, authToken);
        const msg = `🚨 *Hazard Report* 🚨\n\n*Summary:* ${analysis.summary || "N/A"}\n*Risk Level:* ${analysis.risk_level || "N/A"}\n*Location:* ${analysis.possible_location || "Unknown"}\n*Confidence:* ${((analysis.confidence || 0) * 100).toFixed(0)}%\n\nReported via Hazard Lens.`;

        await client.messages.create({
          from: `whatsapp:${twilioFrom}`,
          to: `whatsapp:${authorityPhone}`,
          body: msg,
        });

        whatsappSent = true;
        whatsappReason = "sent";
      } catch (err: any) {
        whatsappSent = false;
        whatsappReason = `error_${(err?.message || "unknown").slice(0, 50)}`;
      }
    }

    await sql`INSERT INTO incidents (id, session_id, role, content, whatsapp_attempted, whatsapp_sent, whatsapp_reason, created_at)
              VALUES (${reportId}, ${session_id}, 'report',
                      ${JSON.stringify({ status: "reported", analysis_id: rows[0].id, whatsapp: whatsappSent })},
                      ${enabled ? 1 : 0}, ${whatsappSent ? 1 : 0}, ${whatsappReason}, ${now()})`;

    return NextResponse.json({
      status: "reported",
      report_id: reportId,
      whatsapp_attempted: enabled,
      whatsapp_sent: whatsappSent,
      whatsapp_reason: whatsappReason,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "internal_error" }, { status: 500 });
  }
}
