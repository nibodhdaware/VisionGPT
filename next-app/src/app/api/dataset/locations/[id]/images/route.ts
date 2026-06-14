import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await sql`
    SELECT id, location_id, r2_key, street_view_url, latitude, longitude,
           collected_at, analyzed_at, gemini_response, error
    FROM dataset_images WHERE location_id = ${id} ORDER BY collected_at DESC
  `;
  return NextResponse.json({
    items: rows.map((r: any) => ({
      id: r.id,
      location_id: r.location_id,
      image_url: r.r2_key ? `/api/dataset/images/${r.id}/file` : (r.street_view_url || null),
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
