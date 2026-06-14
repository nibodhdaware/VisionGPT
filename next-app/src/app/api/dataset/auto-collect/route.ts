import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { checkStreetViewCoverage, fetchStreetView } from "@/lib/streetview";
import { reverseGeocode } from "@/lib/geocode";
import { hashId, now, generateSpiralPoints } from "@/lib/utils";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!lat || !lng) {
      return NextResponse.json({ error: "latitude and longitude required" }, { status: 400 });
    }

    const maxLocations = Math.min(Number(body.max_locations) || 20, 100);
    const stepMeters = Number(body.step_meters) || 50;
    const maxRadiusKm = Math.min(Number(body.max_radius_km) || 5, 50);

    // Clean up old auto-generated locations
    await sql`DELETE FROM dataset_images WHERE location_id IN (SELECT id FROM locations WHERE name LIKE 'Auto %')`;
    await sql`DELETE FROM locations WHERE name LIKE 'Auto %'`;

    const candidates = generateSpiralPoints(lat, lng, stepMeters, maxRadiusKm, maxLocations * 10);
    const created: any[] = [];
    let totalChecked = 0;
    const locationCache = new Map<string, { id: string; name: string }>();

    for (const { lat: clat, lng: clng } of candidates) {
      if (locationCache.size >= maxLocations) break;
      totalChecked++;

      const hasCoverage = await checkStreetViewCoverage(clat, clng);
      if (!hasCoverage) continue;

      // Reverse geocode to get location hierarchy
      const geocoded = await reverseGeocode(clat, clng).catch(() => null);
      if (!geocoded) continue;

      const area = geocoded.address_components?.area || "";
      const district = geocoded.address_components?.district || "";
      const state = geocoded.address_components?.state || "";
      const country = geocoded.address_components?.country || "";
      const parts = [district, state, country].filter(Boolean);
      if (parts.length < 2) continue;

      const groupKey = parts.join(", ");

      // Find or create location for this group
      if (!locationCache.has(groupKey)) {
        const locId = hashId("area", groupKey);
        await sql`
          INSERT INTO locations (id, name, latitude, longitude, collection_frequency, created_at)
          VALUES (${locId}, ${groupKey}, ${geocoded.latitude}, ${geocoded.longitude}, 'weekly', ${now()})
          ON CONFLICT (id) DO NOTHING
        `;
        locationCache.set(groupKey, { id: locId, name: groupKey });
      }

      const loc = locationCache.get(groupKey)!;
      const imageId = hashId(loc.id, String(clat), String(clng), now());
      const { url: r2Key, error: fetchError } = await fetchStreetView(clat, clng, imageId);
      const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${clat},${clng}&key=${process.env.GEOCODING_API_KEY || ""}`;

      if (fetchError) {
        if (fetchError !== "no_street_view_imagery") {
          await sql`
            INSERT INTO dataset_images (id, location_id, r2_key, street_view_url, latitude, longitude, collected_at, error)
            VALUES (${imageId}, ${loc.id}, '', ${svUrl}, ${clat}, ${clng}, ${now()}, ${fetchError})
          `;
          created.push({ id: loc.id, name: loc.name, latitude: clat, longitude: clng, image_id: imageId, error: fetchError });
        }
        continue;
      }

      // Use reverse-geocode data as analysis (no Gemini)
      const analysis = {
        summary: `Street view at ${clat.toFixed(4)}, ${clng.toFixed(4)}`,
        possible_location: groupKey,
        confidence: 0.9,
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
        formatted_address: geocoded.formatted_address || "",
        country,
        state,
        district,
        area,
      };

      await sql`
        INSERT INTO dataset_images (id, location_id, r2_key, street_view_url, latitude, longitude, collected_at, analyzed_at, gemini_response, error)
        VALUES (${imageId}, ${loc.id}, ${r2Key!}, ${svUrl}, ${clat}, ${clng}, ${now()}, ${now()}, ${JSON.stringify(analysis)}, null)
      `;

      created.push({ id: loc.id, name: loc.name, latitude: clat, longitude: clng, image_id: imageId, error: null });
    }

    return NextResponse.json({ items: created, total_checked: totalChecked, found: created.length });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "internal_error" }, { status: 500 });
  }
}
