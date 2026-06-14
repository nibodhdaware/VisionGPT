export async function geocodeLocation(query: string) {
  const key = process.env.GEOCODING_API_KEY;
  if (!key || !query) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== "OK" || !data.results?.length) return null;
    const result = data.results[0];
    const loc = result.geometry?.location || {};
    return {
      latitude: loc.lat,
      longitude: loc.lng,
      formatted_address: result.formatted_address || "",
      place_id: result.place_id || "",
      address_components: extractAddressComponents(result.address_components || []),
    };
  } catch {
    return null;
  }
}

function extractAddressComponents(components: { types: string[]; long_name: string; short_name: string }[]) {
  const map: Record<string, string> = {};
  for (const c of components) {
    if (c.types.includes("country")) map.country = c.long_name;
    else if (c.types.includes("administrative_area_level_1")) map.state = c.long_name;
    else if (c.types.includes("administrative_area_level_2")) map.district = c.long_name;
    else if (c.types.includes("administrative_area_level_3") || c.types.includes("administrative_area_level_4") || c.types.includes("locality") || c.types.includes("sublocality")) map.area = c.long_name;
  }
  return map;
}

export async function reverseGeocode(lat: number, lng: number) {
  const key = process.env.GEOCODING_API_KEY;
  if (!key) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== "OK" || !data.results?.length) return null;
    const result = data.results[0];
    const loc = result.geometry?.location || {};
    return {
      latitude: loc.lat,
      longitude: loc.lng,
      formatted_address: result.formatted_address || "",
      address_components: extractAddressComponents(result.address_components || []),
    };
  } catch {
    return null;
  }
}
