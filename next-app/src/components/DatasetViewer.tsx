"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { MapPin, Plus, Loader2, Trash2, Camera, AlertTriangle, Navigation, Play, ChevronLeft, ChevronRight, X, Crosshair } from "lucide-react";

type Location_ = {
  id: string; name: string; latitude: number; longitude: number;
  collection_frequency: string; created_at: string;
};

type Analysis = {
  summary?: string; location_name?: string | null; possible_location?: string;
  confidence?: number; entities?: string[]; country?: string; state?: string;
  district?: string; area?: string; formatted_address?: string;
  latitude?: number; longitude?: number; model_error?: string;
};

type DatasetImage = {
  id: string; location_id: string; image_url: string | null;
  street_view_url: string | null; latitude: number; longitude: number;
  collected_at: string; analyzed_at: string | null;
  analysis: Analysis | null; error: string | null;
};

type AutoCollectItem = {
  id: string; name: string; latitude: number; longitude: number;
  image_id: string; error: string | null;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const FREQ_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function ConfidenceBadge({ confidence }: { confidence?: number }) {
  if (confidence === undefined) return null;
  const color = confidence > 0.7 ? "#22c55e" : confidence > 0.4 ? "#f59e0b" : "#ef4444";
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold"
      style={{ background: `${color}18`, color }}>
      {(confidence * 100).toFixed(0)}%
    </span>
  );
}

function AddLocationModal({ apiBase, onClose, onCreated, initialLat, initialLng }: {
  apiBase: string; onClose: () => void; onCreated: () => void;
  initialLat?: number; initialLng?: number;
}) {
  const [name, setName] = useState("");
  const [lat, setLat] = useState(initialLat?.toFixed(6) ?? "");
  const [lng, setLng] = useState(initialLng?.toFixed(6) ?? "");
  const [freq, setFreq] = useState("weekly");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !lat || !lng) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/dataset/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), latitude: parseFloat(lat), longitude: parseFloat(lng), collection_frequency: freq }),
      });
      if (!res.ok) throw new Error();
      onCreated();
      onClose();
    } catch { /* ignore */ } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border p-6" style={{ borderColor: "#262626", background: "#161616" }}
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4" style={{ color: "#e8e6e3" }}>Add Location</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" placeholder="Location name" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border bg-transparent px-4 py-2.5 text-sm outline-none transition-colors focus:border-red-500"
            style={{ borderColor: "#262626", color: "#e8e6e3" }} />
          <div className="flex gap-3">
            <input type="number" step="any" placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)}
              className="flex-1 rounded-xl border bg-transparent px-4 py-2.5 text-sm font-mono outline-none transition-colors focus:border-red-500"
              style={{ borderColor: "#262626", color: "#e8e6e3" }} />
            <input type="number" step="any" placeholder="Longitude" value={lng} onChange={(e) => setLng(e.target.value)}
              className="flex-1 rounded-xl border bg-transparent px-4 py-2.5 text-sm font-mono outline-none transition-colors focus:border-red-500"
              style={{ borderColor: "#262626", color: "#e8e6e3" }} />
          </div>
          <select value={freq} onChange={(e) => setFreq(e.target.value)}
            className="w-full rounded-xl border bg-transparent px-4 py-2.5 text-sm outline-none"
            style={{ borderColor: "#262626", color: "#e8e6e3" }}>
            {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving || !name.trim() || !lat || !lng}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all active:scale-[0.97] disabled:opacity-40"
              style={{ background: "#ef4444", color: "#fff" }}>
              {saving ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Save Location"}
            </button>
            <button type="button" onClick={onClose}
              className="rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[#1c1c1c]"
              style={{ borderColor: "#262626", color: "#a3a3a3" }}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CarouselOverlay({ images, idx, apiBase, onClose, onPrev, onNext }: {
  images: DatasetImage[]; idx: number; apiBase: string;
  onClose: () => void; onPrev: () => void; onNext: () => void;
}) {
  const img = images[idx];
  const prevIdx = idx > 0 ? idx - 1 : null;
  const nextIdx = idx < images.length - 1 ? idx + 1 : null;

  function imgUrl(img: DatasetImage) {
    if (img.image_url) return img.image_url.startsWith("http") ? img.image_url : `${apiBase}${img.image_url}`;
    if (img.street_view_url) return img.street_view_url;
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex flex-1 flex-col lg:flex-row" onClick={(e) => e.stopPropagation()}>
        <div className="flex-1 flex items-center justify-center min-h-0 p-4 relative">
          {img.error ? (
            <div className="text-center">
              <AlertTriangle className="mx-auto mb-3 h-12 w-12" style={{ color: "#ef4444" }} />
              <p className="text-sm" style={{ color: "#ef4444" }}>{img.error === "no_street_view_imagery" ? "No Street View imagery" : "Collection failed"}</p>
              <p className="mt-1 text-xs" style={{ color: "#737373" }}>{img.error}</p>
            </div>
          ) : imgUrl(img) ? (
            <img src={imgUrl(img)!} alt="Street view" className="max-h-full max-w-full rounded-xl object-contain shadow-2xl" />
          ) : (
            <p className="text-sm" style={{ color: "#525252" }}>No image</p>
          )}

          {/* Nav arrows overlaid on image */}
          {prevIdx !== null && (
            <button onClick={(e) => { e.stopPropagation(); onPrev(); }}
              className="absolute left-6 top-1/2 -translate-y-1/2 z-10 rounded-full border p-2 transition-colors hover:bg-white/10"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}>
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {nextIdx !== null && (
            <button onClick={(e) => { e.stopPropagation(); onNext(); }}
              className="absolute right-6 top-1/2 -translate-y-1/2 z-10 rounded-full border p-2 transition-colors hover:bg-white/10"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}>
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>

        {/* Details sidebar */}
        <div className="w-full lg:w-80 flex-shrink-0 overflow-y-auto border-l p-5 space-y-4"
          style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.4)" }}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-mono" style={{ color: "#737373" }}>
              {idx + 1} / {images.length}
            </p>
            <button onClick={onClose} className="rounded-full p-1.5 transition-colors hover:bg-white/10" style={{ color: "#a3a3a3" }}>
              <X className="h-4 w-4" />
            </button>
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Coordinates</p>
            <p className="text-sm font-mono" style={{ color: "#d1d5db" }}>
              {img.latitude.toFixed(5)}, {img.longitude.toFixed(5)}
            </p>
          </div>

          {img.analysis && !img.analysis.model_error && (
            <>
              {img.analysis.possible_location && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Possible Location</p>
                  <p className="text-sm font-medium" style={{ color: "#e8e6e3" }}>{img.analysis.possible_location}</p>
                </div>
              )}
              {img.analysis.formatted_address && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Address</p>
                  <p className="text-xs" style={{ color: "#a3a3a3" }}>{img.analysis.formatted_address}</p>
                </div>
              )}
              {(img.analysis.country || img.analysis.state || img.analysis.district || img.analysis.area) && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Hierarchy</p>
                  <div className="space-y-0.5">
                    {img.analysis.area && <p className="text-xs" style={{ color: "#a3a3a3" }}>Area: {img.analysis.area}</p>}
                    {img.analysis.district && <p className="text-xs" style={{ color: "#a3a3a3" }}>District: {img.analysis.district}</p>}
                    {img.analysis.state && <p className="text-xs" style={{ color: "#a3a3a3" }}>State: {img.analysis.state}</p>}
                    {img.analysis.country && <p className="text-xs" style={{ color: "#a3a3a3" }}>Country: {img.analysis.country}</p>}
                  </div>
                </div>
              )}
              {img.analysis.summary && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Summary</p>
                  <p className="text-xs leading-relaxed" style={{ color: "#a3a3a3" }}>{img.analysis.summary}</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#525252" }}>Confidence</p>
                <ConfidenceBadge confidence={img.analysis.confidence} />
              </div>
            </>
          )}

          {img.analysis?.model_error && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Analysis</p>
              <p className="text-xs" style={{ color: "#f59e0b" }}>{img.analysis.model_error}</p>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Collected</p>
            <p className="text-xs font-mono" style={{ color: "#a3a3a3" }}>{formatDate(img.collected_at)}</p>
          </div>
          {img.analyzed_at && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#525252" }}>Analyzed</p>
              <p className="text-xs font-mono" style={{ color: "#a3a3a3" }}>{formatDate(img.analyzed_at)}</p>
            </div>
          )}
          {img.error && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#ef4444" }}>Error</p>
              <p className="text-xs" style={{ color: "#ef4444" }}>{img.error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DatasetViewer({ apiBase }: { apiBase: string }) {
  const [locations, setLocations] = useState<Location_[]>([]);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [selectedLocId, setSelectedLocId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [clickCoords, setClickCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [selectedImageIdx, setSelectedImageIdx] = useState<number | null>(null);

  // Keyboard nav for carousel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selectedImageIdx === null) return;
      if (e.key === "Escape") { setSelectedImageIdx(null); return; }
      if (e.key === "ArrowLeft" && selectedImageIdx > 0) { setSelectedImageIdx(selectedImageIdx - 1); return; }
      if (e.key === "ArrowRight" && selectedImageIdx < images.length - 1) { setSelectedImageIdx(selectedImageIdx + 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedImageIdx, images.length]);

  const [autoCenter, setAutoCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState("");
  const [autoResults, setAutoResults] = useState<AutoCollectItem[]>([]);
  const [autoMax, setAutoMax] = useState(10);
  const [autoRadius, setAutoRadius] = useState(3);
  const [autoStep, setAutoStep] = useState(40);

  // Live progress spinner during auto-collect
  const autoTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (autoRunning) {
      let dots = 0;
      autoTickRef.current = setInterval(() => {
        dots = (dots + 1) % 4;
        setAutoProgress(`Collecting${".".repeat(dots)}  (${locations.length} locations so far)`);
      }, 800);
    } else {
      if (autoTickRef.current) clearInterval(autoTickRef.current);
    }
    return () => { if (autoTickRef.current) clearInterval(autoTickRef.current); };
  }, [autoRunning, locations.length]);

  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const centerMarkerRef = useRef<any>(null);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/dataset/locations`);
      if (!res.ok) return;
      const data = await res.json();
      setLocations(data.items || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiBase]);

  const fetchImages = useCallback(async (locId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/dataset/locations/${locId}/images`);
      if (!res.ok) return;
      const data = await res.json();
      setImages(data.items || []);
    } catch { /* ignore */ }
  }, [apiBase]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  // Poll locations + images in real-time during auto-collect
  useEffect(() => {
    if (!autoRunning) return;
    const id = setInterval(() => {
      fetchLocations();
      if (selectedLocId) fetchImages(selectedLocId);
    }, 2000);
    return () => clearInterval(id);
  }, [autoRunning, fetchLocations, fetchImages, selectedLocId]);

  useEffect(() => {
    if (selectedLocId) fetchImages(selectedLocId);
    else setImages([]);
  }, [selectedLocId, fetchImages]);

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    let cancelled = false;
    import("leaflet").then((L) => {
      if (cancelled || !mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(mapRef.current, {
        center: [20.5937, 78.9629], zoom: 5,
        zoomControl: true, attributionControl: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, className: "dark-map",
      }).addTo(map);
      map.on("click", (e: any) => {
        setClickCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
        setShowAddModal(true);
      });
      mapInstance.current = map;
    });
    return () => { cancelled = true; mapInstance.current?.remove(); mapInstance.current = null; };
  }, []);

  // Markers
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapInstance.current;
    if (!L || !map) return;
    markersRef.current.forEach((m: any) => m.remove());
    markersRef.current = [];
    locations.forEach((loc) => {
      const marker = L.marker([loc.latitude, loc.longitude], {
        icon: L.divIcon({
          className: "",
          html: `<div style="width:14px;height:14px;background:#ef4444;border:2px solid white;border-radius:50%;box-shadow:0 0 8px rgba(239,68,68,0.5)"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        }),
      }).addTo(map);
      marker.on("click", () => setSelectedLocId(loc.id));
      markersRef.current.push(marker);
    });
  }, [locations]);

  // Center marker
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapInstance.current;
    if (!L || !map) return;
    if (centerMarkerRef.current) { centerMarkerRef.current.remove(); centerMarkerRef.current = null; }
    if (autoCenter) {
      centerMarkerRef.current = L.marker([autoCenter.lat, autoCenter.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 12px rgba(59,130,246,0.6)"></div>`,
          iconSize: [16, 16], iconAnchor: [8, 8],
        }),
        zIndexOffset: 1000,
      }).addTo(map);
    }
  }, [autoCenter]);

  async function handleCollect(locId: string) {
    setCollecting(locId);
    try {
      await fetch(`${apiBase}/api/dataset/locations/${locId}/collect`, { method: "POST" });
      if (locId === selectedLocId) fetchImages(locId);
      fetchLocations();
    } catch { /* ignore */ } finally { setCollecting(null); }
  }

  async function handleDelete(locId: string) {
    if (!window.confirm("Delete this location and all its collected images?")) return;
    try {
      await fetch(`${apiBase}/api/dataset/locations/${locId}`, { method: "DELETE" });
      if (selectedLocId === locId) setSelectedLocId(null);
      fetchLocations();
    } catch { /* ignore */ }
  }

  function handleGetLocation() {
    if (!navigator.geolocation) return;
    setAutoProgress("Getting your location...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setAutoCenter({ lat, lng });
        setAutoProgress(`Center: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        mapInstance.current?.setView([lat, lng], 15);
      },
      () => setAutoProgress("Could not get location. Check browser permissions."),
    );
  }

  async function handleAutoCollect() {
    if (!autoCenter) return;
    setAutoRunning(true);
    setAutoProgress("Searching for street view locations...");
    setAutoResults([]);

    try {
      const res = await fetch(`${apiBase}/api/dataset/auto-collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: autoCenter.lat, longitude: autoCenter.lng,
          max_locations: autoMax, step_meters: autoStep, max_radius_km: autoRadius,
        }),
      });
      const data = await res.json();
      setAutoResults(data.items || []);
      setAutoProgress(`Done — checked ${data.total_checked} spots, found ${data.found} locations`);
      fetchLocations();
      if (selectedLocId) fetchImages(selectedLocId);
    } catch { setAutoProgress("Auto-collect failed"); } finally { setAutoRunning(false); }
  }

  const selectedLoc = locations.find(l => l.id === selectedLocId);

  return (
    <div className="flex h-full">
      {showAddModal && (
        <AddLocationModal
          apiBase={apiBase}
          onClose={() => { setShowAddModal(false); setClickCoords(null); }}
          onCreated={fetchLocations}
          initialLat={clickCoords?.lat} initialLng={clickCoords?.lng}
        />
      )}
      {selectedImageIdx !== null && images.length > 0 && (
        <CarouselOverlay
          images={images}
          idx={selectedImageIdx}
          apiBase={apiBase}
          onClose={() => setSelectedImageIdx(null)}
          onPrev={() => setSelectedImageIdx(selectedImageIdx - 1)}
          onNext={() => setSelectedImageIdx(selectedImageIdx + 1)}
        />
      )}

      <aside className="w-72 flex-shrink-0 border-r overflow-y-auto" style={{ borderColor: "#1c1c1c" }}>
        {/* Auto-collect */}
        <div className="border-b p-3" style={{ borderColor: "#1c1c1c" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#525252" }}>Auto-Collect</h3>
          <div className="space-y-2">
            <button onClick={handleGetLocation} disabled={autoRunning}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all hover:bg-[#1c1c1c] active:scale-[0.97] disabled:opacity-40"
              style={{ borderColor: "#262626", color: "#a3a3a3" }}>
              <Navigation className="h-3 w-3" />
              {autoCenter ? "📍 Center Set" : "Use My Location"}
            </button>
            <div className="flex gap-1.5">
              <input type="number" min={1} max={100} value={autoMax} onChange={(e) => setAutoMax(Number(e.target.value))}
                className="w-12 rounded-lg border bg-transparent px-2 py-1.5 text-[10px] font-mono text-center outline-none"
                style={{ borderColor: "#262626", color: "#a3a3a3" }} title="Max locations" />
              <input type="number" min={1} max={50} value={autoRadius} onChange={(e) => setAutoRadius(Number(e.target.value))}
                className="w-12 rounded-lg border bg-transparent px-2 py-1.5 text-[10px] font-mono text-center outline-none"
                style={{ borderColor: "#262626", color: "#a3a3a3" }} title="Radius (km)" />
              <input type="number" min={10} max={500} value={autoStep} onChange={(e) => setAutoStep(Number(e.target.value))}
                className="w-14 rounded-lg border bg-transparent px-2 py-1.5 text-[10px] font-mono text-center outline-none"
                style={{ borderColor: "#262626", color: "#a3a3a3" }} title="Step (m)" />
              <button onClick={handleAutoCollect} disabled={autoRunning || !autoCenter}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-semibold transition-all active:scale-[0.97] disabled:opacity-40"
                style={{ background: autoCenter ? "#ef4444" : "#262626", color: autoCenter ? "#fff" : "#525252" }}>
                {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Start
              </button>
            </div>
            {autoProgress && <p className="text-[10px]" style={{ color: "#525252" }}>{autoProgress}</p>}
            {autoResults.length > 0 && (
              <div className="mt-1 max-h-24 overflow-y-auto space-y-0.5">
                {autoResults.map(r => (
                  <div key={r.id} className="flex items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: "rgba(34,197,94,0.06)" }}>
                    <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: r.error ? "#f59e0b" : "#22c55e" }} />
                    <span className="text-[10px] font-mono truncate" style={{ color: "#a3a3a3" }}>
                      {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
                    </span>
                    {r.error && <span className="text-[9px] flex-shrink-0" style={{ color: "#f59e0b" }}>{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Location list header */}
        <div className="flex items-center justify-between border-b px-3 py-3" style={{ borderColor: "#1c1c1c" }}>
          <span className="text-sm font-semibold" style={{ color: "#d1d5db" }}>Locations ({locations.length})</span>
          <button onClick={() => { setClickCoords(null); setShowAddModal(true); }}
            className="rounded-lg p-1.5 transition-colors hover:bg-[#1c1c1c]" style={{ color: "#a3a3a3" }}>
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-4 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" style={{ color: "#525252" }} /></div>
        ) : locations.length === 0 ? (
          <div className="mt-8 text-center px-4">
            <p className="text-xs" style={{ color: "#525252" }}>No locations yet</p>
            <p className="mt-1 text-xs" style={{ color: "#525252" }}>Click the map or + to add one</p>
          </div>
        ) : (
          <div className="p-1.5 space-y-0.5">
            {locations.map(loc => (
              <button key={loc.id} onClick={() => setSelectedLocId(loc.id)}
                className="w-full rounded-xl px-3 py-2.5 text-left transition-all"
                style={{
                  background: selectedLocId === loc.id ? "rgba(239,68,68,0.08)" : "transparent",
                  border: `1px solid ${selectedLocId === loc.id ? "rgba(239,68,68,0.2)" : "transparent"}`,
                }}>
                <p className="text-sm font-medium truncate" style={{ color: "#e8e6e3" }}>{loc.name}</p>
                <span className="text-[11px] font-mono" style={{ color: "#525252" }}>
                  {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedLoc ? (
          <>
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "#1c1c1c" }}>
              <div>
                <h2 className="text-base font-bold tracking-tight" style={{ color: "#e8e6e3" }}>{selectedLoc.name}</h2>
                <p className="text-xs font-mono" style={{ color: "#525252" }}>
                  {selectedLoc.latitude.toFixed(5)}, {selectedLoc.longitude.toFixed(5)}
                  <span className="ml-2">· {selectedLoc.collection_frequency}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleCollect(selectedLoc.id)} disabled={collecting === selectedLoc.id}
                  className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all active:scale-[0.97] disabled:opacity-40"
                  style={{ background: "#ef4444", color: "#fff" }}>
                  {collecting === selectedLoc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                  Collect
                </button>
                <button onClick={() => handleDelete(selectedLoc.id)}
                  className="rounded-xl border px-3 py-2 text-xs font-medium transition-colors hover:bg-[#1c1c1c]"
                  style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {images.length === 0 ? (
                <div className="mt-16 text-center">
                  <Camera className="mx-auto mb-3 h-10 w-10" style={{ color: "#262626" }} />
                  <p className="text-sm" style={{ color: "#525252" }}>No images collected yet</p>
                  <p className="mt-1 text-xs" style={{ color: "#525252" }}>Click "Collect" to fetch a Street View image</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {images.map((img, i) => (
                    <button key={img.id} onClick={() => setSelectedImageIdx(i)}
                      className="overflow-hidden rounded-xl border text-left w-full transition-all hover:border-red-500/30 active:scale-[0.98]"
                      style={{ borderColor: "#1c1c1c", background: "#161616" }}>
                      {img.error ? (
                        <div className="flex h-40 items-center justify-center" style={{ background: "#0f0f0f" }}>
                          <div className="text-center">
                            <AlertTriangle className="mx-auto mb-1 h-6 w-6" style={{ color: "#ef4444" }} />
                            <p className="text-xs" style={{ color: "#ef4444" }}>
                              {img.error === "no_street_view_imagery" ? "No Street View imagery" : "Collection failed"}
                            </p>
                            <p className="text-[10px] font-mono mt-0.5" style={{ color: "#525252" }}>
                              {img.error === "no_street_view_imagery" ? "Try a different location" : img.error}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="relative h-40" style={{ background: "#0f0f0f" }}>
                          {img.image_url ? (
                            <img src={img.image_url?.startsWith("http") ? img.image_url : `${apiBase}${img.image_url}`} alt="Street view" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center">
                              <p className="text-xs" style={{ color: "#525252" }}>No image</p>
                            </div>
                          )}
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6">
                            <p className="text-[10px] font-mono text-white/80">{formatDate(img.collected_at)}</p>
                          </div>
                        </div>
                      )}
                      {img.analysis && !img.analysis.model_error && (
                        <div className="p-3 space-y-2">
                          {img.analysis.possible_location && (
                            <p className="text-sm font-medium truncate" style={{ color: "#d1d5db" }}>
                              {img.analysis.possible_location}
                            </p>
                          )}
                          <div className="flex items-center gap-1.5">
                            <ConfidenceBadge confidence={img.analysis.confidence} />
                            {img.analysis.summary && (
                              <span className="text-[10px] truncate" style={{ color: "#525252" }}>{img.analysis.summary}</span>
                            )}
                          </div>
                          {(img.analysis.country || img.analysis.state) && (
                            <div className="flex items-center gap-1 text-[10px] font-mono" style={{ color: "#525252" }}>
                              {[img.analysis.area, img.analysis.district, img.analysis.state, img.analysis.country]
                                .filter(Boolean).map((part, i) => (
                                  <span key={i} className="inline-flex items-center gap-0.5">
                                    {i > 0 && <span className="mx-0.5">›</span>}{part}
                                  </span>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                      {img.analysis?.model_error && (
                        <div className="p-3">
                          <p className="text-xs" style={{ color: "#f59e0b" }}>Analysis: {img.analysis.model_error}</p>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="flex-1 relative">
              <div ref={mapRef} className="absolute inset-0" />
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border px-4 py-2 text-xs backdrop-blur-md whitespace-nowrap"
                style={{ borderColor: "#262626", background: "rgba(22,22,22,0.9)", color: "#a3a3a3" }}>
                Click map to add a location · Click pins to view collected images
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
