import { NextRequest, NextResponse } from "next/server";
import { generateContent } from "@/lib/gemini";

export async function GET(req: NextRequest) {
  try {
    const query = req.nextUrl.searchParams.get("query") || "";
    if (!query) {
      return NextResponse.json({ error: "query required" }, { status: 400 });
    }

    const { text, error } = await generateContent([
      { text: `Provide safety information about this hazard or situation. Keep it concise (2-3 sentences). Return as JSON with "title" and "summary" fields.\n\nQuery: ${query}` },
    ], true);

    if (!text || error) {
      return NextResponse.json({ title: query, summary: "No information available." });
    }

    try {
      const parsed = JSON.parse(text);
      return NextResponse.json({
        title: parsed.title || query,
        summary: parsed.summary || "No summary available.",
      });
    } catch {
      return NextResponse.json({ title: query, summary: text });
    }
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
