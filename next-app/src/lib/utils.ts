import crypto from "crypto";

export function now() {
  return new Date().toISOString();
}

export function hashId(...parts: string[]) {
  return crypto.createHash("sha1").update(parts.join("-")).digest("hex").slice(0, 16);
}

export function extractJson(text: string): Record<string, any> | null {
  const match = text.match(/(?:```(?:json)?\s*)?({[\s\S]*?})(?:\s*```)?/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function generateSpiralPoints(
  centerLat: number,
  centerLng: number,
  stepMeters: number,
  maxRadiusKm: number,
  maxPoints: number,
): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  const latDeg = stepMeters / 111_320;
  const maxRDeg = maxRadiusKm / 111.32;
  const goldenAngle = Math.PI * 0.618033988749895;
  let theta = 0;
  for (let i = 0; i < maxPoints; i++) {
    const r = latDeg * Math.sqrt(i + 1);
    if (r > maxRDeg) break;
    theta += goldenAngle;
    const dx = r * Math.cos(theta);
    const dy = r * Math.sin(theta);
    const lng = centerLng + dx / Math.max(Math.cos(centerLat * (Math.PI / 180)), 0.01);
    const lat = centerLat + dy;
    points.push({ lat, lng });
  }
  return points;
}
