import { NextRequest, NextResponse } from "next/server";
import { getFromR2 } from "@/lib/r2";

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const { key } = await params;
    const imageKey = key.join("/");
    const buffer = await getFromR2(imageKey);
    if (!buffer) {
      return new NextResponse("Not found", { status: 404 });
    }
    const ext = imageKey.split(".").pop()?.toLowerCase();
    const mime: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": mime[ext || ""] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return new NextResponse("Error", { status: 500 });
  }
}
