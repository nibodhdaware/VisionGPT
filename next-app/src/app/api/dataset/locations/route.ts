import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hashId, now } from "@/lib/utils";

export async function GET() {
  const rows = await sql`
    SELECT id, name, latitude, longitude, collection_frequency, created_at
    FROM locations ORDER BY created_at DESC
  `;
  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const { name, latitude, longitude, collection_frequency } = body;
    if (!name || typeof latitude !== "number" || typeof longitude !== "number") {
      return NextResponse.json({ error: "name, latitude, longitude required" }, { status: 400 });
    }
    const freq = ["daily", "weekly", "monthly"].includes(collection_frequency) ? collection_frequency : "weekly";
    const id = hashId(name, now());
    await sql`
      INSERT INTO locations (id, name, latitude, longitude, collection_frequency, created_at)
      VALUES (${id}, ${name.slice(0, 200)}, ${latitude}, ${longitude}, ${freq}, ${now()})
    `;
    return NextResponse.json({ id, status: "created" }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "internal_error" }, { status: 500 });
  }
}
