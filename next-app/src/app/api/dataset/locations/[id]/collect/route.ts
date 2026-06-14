import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { generateContent, parseJson } from "@/lib/gemini";
import { geocodeLocation } from "@/lib/geocode";
import { fetchStreetView } from "@/lib/streetview";
import { hashId, now } from "@/lib/utils";

const ANALYSIS_PROMPT = `You are a geolocation expert. Identify where this Google Street View photo was taken based on visual clues. Be as specific as possible — at minimum identify the city and country. Return JSON only:
{"summary": string, "location_name": string|null, "possible_location": string, "confidence": number_0_to_1, "entities": string[]}`;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: locationId } = await params;
  const rows = await sql`SELECT * FROM locations WHERE id = ${locationId}`;
  if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const loc = rows[0];

  const imageId = hashId(loc.id, now());
  const { url: r2Key, error: fetchError } = await fetchStreetView(loc.latitude, loc.longitude, imageId);

  if (fetchError) {
    const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${loc.latitude},${loc.longitude}`;
    await sql`
      INSERT INTO dataset_images (id, location_id, r2_key, street_view_url, latitude, longitude, collected_at, error)
      VALUES (${imageId}, ${loc.id}, '', ${svUrl}, ${loc.latitude}, ${loc.longitude}, ${now()}, ${fetchError})
    `;
    return NextResponse.json({ status: "error", error: fetchError }, { status: 500 });
  }

  // Analyze with Gemini
  const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${loc.latitude},${loc.longitude}`;
  let analysis: Record<string, any> = {};

  // Try to fetch image from R2 for analysis
  const { getFromR2 } = await import("@/lib/r2");
  const imageBuffer = await getFromR2(r2Key!);
  if (imageBuffer) {
    const b64 = imageBuffer.toString("base64");
    const parts = [
      { text: ANALYSIS_PROMPT },
      { inlineData: { mimeType: "image/jpeg" as const, data: b64 } },
    ];
    const { text, error: modelError } = await generateContent(parts);
    if (text) {
      let parsed = parseJson(text);
      if (!parsed) {
        const { text: repairedText } = await generateContent([{ text: `Convert to valid JSON:\n${text}` }], true);
        if (repairedText) parsed = parseJson(repairedText);
      }
      if (parsed) {
        analysis.summary = String(parsed.summary || "");
        analysis.location_name = parsed.location_name ? String(parsed.location_name) : null;
        analysis.possible_location = String(parsed.possible_location || "");
        analysis.confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
        analysis.entities = (parsed.entities || []).slice(0, 8).map(String);

        const placeGuess = analysis.possible_location || analysis.location_name;
        if (placeGuess) {
          const geocoded = await geocodeLocation(placeGuess);
          if (geocoded) {
            analysis.latitude = geocoded.latitude;
            analysis.longitude = geocoded.longitude;
            analysis.formatted_address = geocoded.formatted_address;
            analysis.country = geocoded.address_components?.country;
            analysis.state = geocoded.address_components?.state;
            analysis.district = geocoded.address_components?.district;
            analysis.area = geocoded.address_components?.area;
          }
        }
      }
    }
    if (!text || modelError) {
      analysis.model_error = modelError || "generation_failed";
    }
  }

  await sql`
    INSERT INTO dataset_images (id, location_id, r2_key, street_view_url, latitude, longitude, collected_at, analyzed_at, gemini_response, error)
    VALUES (${imageId}, ${loc.id}, ${r2Key!}, ${svUrl}, ${loc.latitude}, ${loc.longitude}, ${now()}, ${now()}, ${JSON.stringify(analysis)}, null)
  `;

  return NextResponse.json({ status: "collected", image_id: imageId, analysis });
}
