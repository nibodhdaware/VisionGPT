import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getFromR2 } from "@/lib/r2";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await sql`SELECT r2_key FROM dataset_images WHERE id = ${id}`;
  if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r2Key = (rows[0] as any).r2_key;
  if (!r2Key) return NextResponse.json({ error: "no_image" }, { status: 404 });

  const buffer = await getFromR2(r2Key);
  if (!buffer) return NextResponse.json({ error: "image_not_found" }, { status: 404 });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
