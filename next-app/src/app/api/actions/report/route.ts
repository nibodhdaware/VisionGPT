import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hashId, now } from "@/lib/utils";
import twilio from "twilio";

const RATE_LIMIT_SEC = 60;

function mapsLink(lat: number | null, lng: number | null): string {
  if (lat != null && lng != null) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  return "";
}

function formatAddress(analysis: any): string {
  const parts = [
    analysis.formatted_address,
    analysis.possible_location,
    [analysis.area, analysis.district].filter(Boolean).join(", "),
    [analysis.state, analysis.country].filter(Boolean).join(", "),
  ].filter(Boolean);
  return [...new Set(parts)].join(" | ");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { session_id } = body;
    if (!session_id) {
      return NextResponse.json({ error: "session_id required" }, { status: 400 });
    }

    const recent = await sql`
      SELECT created_at FROM incidents
      WHERE session_id = ${session_id} AND role = 'report' AND created_at > ${new Date(Date.now() - RATE_LIMIT_SEC * 1000).toISOString()}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (recent.length > 0) {
      return NextResponse.json({ error: "rate_limited", message: "Please wait before reporting again" }, { status: 429 });
    }

    const rows = await sql`
      SELECT content, image_url, latitude, longitude, formatted_address, possible_location, country, state, district, area
      FROM incidents
      WHERE session_id = ${session_id} AND role = 'assistant'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: "no_analysis" }, { status: 400 });
    }

    const row = rows[0];
    let analysis: any;
    try {
      analysis = JSON.parse(row.content);
    } catch {
      return NextResponse.json({ error: "invalid_analysis" }, { status: 400 });
    }

    const lat = analysis.latitude ?? row.latitude;
    const lng = analysis.longitude ?? row.longitude;
    const addr = formatAddress({ ...analysis, formatted_address: row.formatted_address || analysis.formatted_address });
    const mapUrl = mapsLink(lat, lng);

    const incidentId = hashId(session_id, now(), "report");

    let whatsappSent = false;
    let whatsappReason = "not_requested";
    const notifyWhatsapp = body.notify_whatsapp !== false;
    const enabled = process.env.ENABLE_WHATSAPP_NOTIFY === "true";
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
    const authorityPhone = process.env.AUTHORITY_WHATSAPP_TO;
    const imageUrl = row.image_url || analysis.image_url;

    if (notifyWhatsapp && enabled && accountSid && authToken && twilioFrom && authorityPhone) {
      try {
        const client = twilio(accountSid, authToken);

        const msg = [
          "🚨 *HAZARD REPORT — ACTION REQUIRED* 🚨",
          "",
          `*${analysis.summary || "Incident reported"}*`,
          "",
          `📍 *Location:* ${addr || analysis.possible_location || "Unknown"}`,
          lat != null && lng != null ? `🗺 *Maps:* ${mapUrl}` : null,
          "",
          `⚠️ *Risk Level:* ${(analysis.risk_level || "uncertain").toUpperCase()}`,
          `📊 *Confidence:* ${((analysis.confidence || 0) * 100).toFixed(0)}%`,
          analysis.entities?.length ? `🏷 *Tags:* ${analysis.entities.slice(0, 5).join(", ")}` : null,
          "",
          analysis.rationale ? `*Details:* ${analysis.rationale}` : null,
          "",
          "🆘 Please dispatch nearest response team.",
          "",
          "_Reported via Hazard Lens_",
        ].filter(Boolean).join("\n");

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
              VALUES (${incidentId}, ${session_id}, 'report',
                      ${JSON.stringify({ status: "reported", analysis_id: row.id, whatsapp: whatsappSent })},
                      ${enabled ? 1 : 0}, ${whatsappSent ? 1 : 0}, ${whatsappReason}, ${now()})`;

    return NextResponse.json({
      status: "reported",
      incident_id: incidentId,
      whatsapp: { sent: whatsappSent, reason: whatsappReason },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "internal_error" }, { status: 500 });
  }
}
