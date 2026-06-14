import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export async function GET() {
  const rows = await sql`
    SELECT di.id, di.location_id, di.r2_key, di.street_view_url,
           di.latitude, di.longitude, di.collected_at, di.analyzed_at,
           di.gemini_response, di.error,
           l.name AS location_name
    FROM dataset_images di
    LEFT JOIN locations l ON di.location_id = l.id
    ORDER BY di.collected_at DESC
  `;
  return NextResponse.json({
    items: rows.map((r: any) => ({
      id: r.id,
      location_id: r.location_id,
      location_name: r.location_name,
      image_url: r.r2_key ? `/api/dataset/images/${r.id}/file` : null,
      street_view_url: r.street_view_url,
      latitude: r.latitude,
      longitude: r.longitude,
      collected_at: r.collected_at,
      analyzed_at: r.analyzed_at,
      analysis: r.gemini_response || null,
      error: r.error,
    })),
  });
}
