import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { deleteFromR2 } from "@/lib/r2";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Clean up R2 images
  const images = await sql`SELECT r2_key FROM dataset_images WHERE location_id = ${id}`;
  for (const img of images) {
    if ((img as any).r2_key) {
      try { await deleteFromR2((img as any).r2_key); } catch { /* ignore */ }
    }
  }

  await sql`DELETE FROM dataset_images WHERE location_id = ${id}`;
  await sql`DELETE FROM locations WHERE id = ${id}`;
  return NextResponse.json({ status: "deleted" });
}
