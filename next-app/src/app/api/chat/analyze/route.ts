import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { generateContent, parseJson } from "@/lib/gemini";
import { geocodeLocation } from "@/lib/geocode";
import { hashId, now } from "@/lib/utils";
import { uploadToR2, r2PublicUrl, isR2Configured } from "@/lib/r2";

const HAZARD_PROMPT = `You are a safety and hazard assessment expert. Analyze the image thoroughly and return JSON only:

{
  "summary": "Brief 1-line description of visible situation",
  "risk_level": "high" | "medium" | "low" | "uncertain",
  "confidence": number (0-1),
  "entities": ["tag1", "tag2"],
  "location_name": null,
  "possible_location": "Best guess of where this was taken (city, area, or null)",
  "rationale": "Key visual clues that informed your assessment",
  "recommended_actions": []
}

Consider: visible hazards, environmental context, structural issues, fires, accidents, etc.`;

const GEOLOCATION_PROMPT = `You are a geolocation expert analyzing an image to identify where it was taken. Be very specific — identify at minimum the city and country.

Visual clues to analyze:
1. Language on signs, billboards, storefronts, vehicles
2. Architecture style (building materials, roof shapes, window styles)
3. Vegetation (trees — look for Gulmohar, Rain Tree, Coconut, Banyan, Pine, etc.)
4. Road markings, traffic signs, street furniture
5. Vehicle types (auto rickshaw colours vary by city — green & yellow in Mumbai, green in Bangalore, black & yellow in Delhi)
6. Climate indicators (dress style, humidity, dust, wet roads)
7. Terrain (mountains, coastline, flat plains, river)
8. Infrastructure quality (paved roads, streetlights, power lines)

IMPORTANT: Do NOT simply say "India" as the location. Be specific.

Return JSON only:
{
  "summary": "Brief description of what's visible",
  "location_name": null,
  "possible_location": "City, State, Country",
  "confidence": number (0-1),
  "entities": ["clue1", "clue2"],
  "rationale": "Key visual clues that led to this conclusion"
}`;

const MAX_UPLOAD_MB = 10;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const sessionId = (formData.get("session_id") as string) || "";
    const message = (formData.get("message") as string) || "Analyze this image";
    const image = formData.get("image") as File | null;

    if (!sessionId) {
      return NextResponse.json({ error: "session_id is required" }, { status: 400 });
    }

    let imageB64: string | null = null;
    let mimeType: string | null = null;
    let imageHash: string | null = null;
    let imageUrl: string | null = null;

    if (image) {
      if (image.size > MAX_UPLOAD_MB * 1024 * 1024) {
        return NextResponse.json({ error: `Image exceeds ${MAX_UPLOAD_MB} MB` }, { status: 400 });
      }
      const buffer = Buffer.from(await image.arrayBuffer());
      imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
      imageB64 = buffer.toString("base64");
      mimeType = image.type || "image/jpeg";
      if (isR2Configured()) {
        const ext = mimeType.split("/").pop() || "jpg";
        const key = `reports/${imageHash}.${ext}`;
        await uploadToR2(key, buffer, mimeType);
        imageUrl = r2PublicUrl(key);
      }
    }

    const userMsgId = hashId(sessionId, now(), "user");
    await sql`INSERT INTO incidents (id, session_id, role, content, image_hash, created_at)
              VALUES (${userMsgId}, ${sessionId}, 'user', ${message}, ${imageHash}, ${now()})`;

    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    const intro = message === "Analyze this image" ? "Analyze this image for hazards and safety concerns." : message;
    parts.push({ text: intro + "\n\n" + HAZARD_PROMPT });

    if (imageB64 && mimeType) {
      parts.push({ inlineData: { mimeType, data: imageB64 } });
    }

    const { text, error } = await generateContent(parts);
    if (!text || error) {
      return NextResponse.json(fallback(message, error || "generation_failed"));
    }

    let structured = parseJson(text);
    if (!structured) {
      const repaired = await generateContent([{ text: `Convert to valid JSON:\n${text}` }], true);
      if (repaired.text) structured = parseJson(repaired.text);
    }
    if (!structured) {
      return NextResponse.json(fallback(message, "parse_failed"));
    }

    const result: any = {
      reply: `${String(structured.summary || "")}\n\nReasoning: ${String(structured.rationale || "")}`,
      summary: String(structured.summary || ""),
      risk_level: ["high", "medium", "low", "uncertain"].includes(structured.risk_level) ? structured.risk_level : "uncertain",
      confidence: Math.min(1, Math.max(0, Number(structured.confidence) || 0)),
      entities: (structured.entities || []).slice(0, 8),
      location_name: structured.location_name || null,
      place_guess: structured.possible_location || null,
      possible_location: structured.possible_location || null,
      rationale: String(structured.rationale || ""),
      recommended_actions: structured.recommended_actions || [],
      actions: [],
    };

    // Geolocation pass
    if (imageB64 && mimeType) {
      const geoParts = [
        { text: GEOLOCATION_PROMPT },
        { inlineData: { mimeType, data: imageB64 } },
      ];
      const geoResult = await generateContent(geoParts);
      if (geoResult.text) {
        const geo = parseJson(geoResult.text);
        if (geo) {
          if (geo.possible_location && geo.confidence > 0.3) {
            result.possible_location = geo.possible_location;
            result.rationale = geo.rationale || result.rationale;
            result.confidence = Math.max(result.confidence, geo.confidence);
          }
          if (geo.entities?.length) {
            result.entities = [...new Set([...result.entities, ...geo.entities.slice(0, 8)])];
          }
        }
      }
    }

    // Geocode
    const placeGuess = result.possible_location || result.location_name;
    if (placeGuess) {
      const geocoded = await geocodeLocation(placeGuess);
      if (geocoded) {
        result.latitude = geocoded.latitude;
        result.longitude = geocoded.longitude;
        result.formatted_address = geocoded.formatted_address;
        result.country = geocoded.address_components?.country;
        result.state = geocoded.address_components?.state;
        result.district = geocoded.address_components?.district;
        result.area = geocoded.address_components?.area;
      }
    }

    const aiMsgId = hashId(sessionId, now(), "ai");
    await sql`INSERT INTO incidents (id, session_id, role, content, image_hash, image_url, hazard_detected, risk_level, confidence, possible_location, country, state, district, area, latitude, longitude, formatted_address, entities, recommended_actions, created_at)
              VALUES (${aiMsgId}, ${sessionId}, 'assistant', ${JSON.stringify(result)}, ${imageHash}, ${imageUrl},
                      ${result.risk_level !== "low" ? 1 : 0}, ${result.risk_level}, ${result.confidence},
                      ${result.possible_location}, ${result.country}, ${result.state}, ${result.district},
                      ${result.area}, ${result.latitude}, ${result.longitude}, ${result.formatted_address},
                      ${JSON.stringify(result.entities)}, ${JSON.stringify(result.recommended_actions)}, ${now()})`;

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(fallback("", err?.message), { status: 500 });
  }
}

function fallback(message: string, reason?: string) {
  const risk = /fight|weapon|blood|fire|flood|collapse/i.test(message) ? "medium" : "uncertain" as const;
  return {
    reply: `Analysis unavailable.\n\nReasoning: ${reason || "unknown"}`,
    summary: "Analysis unavailable.",
    risk_level: risk,
    confidence: risk === "medium" ? 0.5 : 0,
    entities: [],
    location_name: null,
    place_guess: null,
    possible_location: null,
    rationale: `Fallback (${reason || "unknown"})`,
    recommended_actions: [],
    actions: [],
  };
}

