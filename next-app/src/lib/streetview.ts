import { uploadToR2 } from "./r2";

export async function checkStreetViewCoverage(lat: number, lng: number): Promise<boolean> {
  const key = process.env.GEOCODING_API_KEY;
  if (!key) return false;
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${key}`;
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.status === "OK";
  } catch {
    return false;
  }
}

export async function fetchStreetView(lat: number, lng: number, imageId: string): Promise<{ url: string | null; error: string | null }> {
  const key = process.env.GEOCODING_API_KEY;
  if (!key) return { url: null, error: "geocoding_api_key_missing" };

  const streetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${lat},${lng}&key=${key}&source=outdoor&return_error_code=true`;

  try {
    const resp = await fetch(streetViewUrl);
    if (resp.status === 404) return { url: null, error: "no_street_view_imagery" };
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { url: null, error: `streetview_http_${resp.status}: ${body.slice(0, 200)}` };
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 1000) return { url: null, error: "no_street_view_imagery" };

    const r2Key = `streetview/${imageId}.jpg`;
    await uploadToR2(r2Key, buffer, "image/jpeg");
    return { url: r2Key, error: null };
  } catch (err: any) {
    return { url: null, error: `streetview_error: ${(err?.message || String(err)).slice(0, 200)}` };
  }
}
