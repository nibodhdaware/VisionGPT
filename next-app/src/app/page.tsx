"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  AlertTriangle, MapPin, Plus, ShieldAlert, ChevronRight, Clock, Camera,
  Crosshair, Flame, Droplets, TriangleAlert, Send,
  ExternalLink, History, X, ImageUp, Loader2, Layers,
} from "lucide-react";
import DatasetViewer from "@/components/DatasetViewer";

type Risk = "low" | "medium" | "high" | "uncertain";

type AssistantPayload = {
  reply: string;
  risk_level: Risk;
  confidence: number;
  entities: string[];
  location_name: string | null;
  place_guess: string | null;
  latitude: number | null;
  longitude: number | null;
  formatted_address: string | null;
  country: string | null;
  state: string | null;
  district: string | null;
  area: string | null;
  exif_timestamp: string | null;
  exif_camera: string | null;
  actions: { type: string; label: string; payload?: Record<string, string> }[];
};

type AnalysisResult = {
  id: string;
  imageUrl: string;
  timestamp: number;
  payload: AssistantPayload;
};

type Toast = {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

function riskConfig(risk: Risk) {
  switch (risk) {
    case "high":
      return { label: "HIGH ALERT", color: "#ef4444", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)", glow: "0 0 0 1px rgba(239,68,68,0.15), 0 0 20px rgba(239,68,68,0.08)", icon: TriangleAlert };
    case "medium":
      return { label: "CAUTION", color: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)", glow: "0 0 0 1px rgba(245,158,11,0.1)", icon: AlertTriangle };
    case "low":
      return { label: "LOW RISK", color: "#22c55e", bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)", glow: "none", icon: MapPin };
    default:
      return { label: "UNCERTAIN", color: "#6b7280", bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.3)", glow: "none", icon: AlertTriangle };
  }
}

function extractSummary(text: string) {
  const idx = text.indexOf("\n\nReasoning:");
  return idx === -1 ? text.trim() : text.slice(0, idx).trim();
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function HazardIcon({ risk }: { risk: Risk }) {
  switch (risk) {
    case "high": return <Flame className="h-4 w-4" />;
    case "medium": return <Droplets className="h-4 w-4" />;
    case "low": return <MapPin className="h-4 w-4" />;
    default: return <AlertTriangle className="h-4 w-4" />;
  }
}

function MiniMap({ lat, lng }: { lat: number; lng: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<any>(null);

  useEffect(() => {
    import("leaflet").then((L) => {
      if (!ref.current || instance.current) return;
      const map = L.map(ref.current, {
        center: [lat, lng], zoom: 15, zoomControl: false,
        attributionControl: false, dragging: false, scrollWheelZoom: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, className: "dark-map",
      }).addTo(map);
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;background:#ef4444;border:2px solid white;border-radius:50%;box-shadow:0 0 12px rgba(239,68,68,0.6)"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(map);
      instance.current = map;
      setTimeout(() => map.invalidateSize(), 400);
    });
    return () => { instance.current?.remove(); instance.current = null; };
  }, [lat, lng]);

  return (
    <div ref={ref} className="h-full min-h-[156px] w-full cursor-pointer overflow-hidden rounded-xl"
      onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, "_blank")}
    />
  );
}

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-surface-border">
      <div className="flex items-center gap-3 p-3">
        <div className="skeleton-shimmer h-12 w-12 flex-shrink-0 rounded-xl" />
        <div className="flex-1 space-y-2">
          <div className="skeleton-shimmer h-4 w-24 rounded-md" />
          <div className="skeleton-shimmer h-3 w-40 rounded-md" />
        </div>
        <div className="skeleton-shimmer h-3 w-12 rounded-md" />
      </div>
    </div>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  const iconMap = { success: "✓", error: "!", info: "i" } as const;
  const colorMap = { success: "#22c55e", error: "#ef4444", info: "#6b7280" } as const;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2 md:right-6 md:top-6">
      {[...toasts].reverse().map((t) => (
        <div key={t.id} className="toast-enter pointer-events-auto w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl"
          style={{ background: "rgba(22,22,22,0.95)", borderColor: colorMap[t.type] + "40" }}>
          <div className="flex items-start gap-3 p-3">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold"
              style={{ background: colorMap[t.type] + "20", color: colorMap[t.type] }}>
              {iconMap[t.type]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#e8e6e3" }}>{t.title}</p>
              {t.message && <p className="mt-0.5 text-xs leading-relaxed" style={{ color: "#a3a3a3" }}>{t.message}</p>}
            </div>
            <button onClick={() => onDismiss(t.id)} className="flex-shrink-0 rounded-lg p-1 transition-colors hover:bg-surface-hover" style={{ color: "#525252" }}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [sessionId] = useState(() => crypto.randomUUID());
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragCounter, setDragCounter] = useState(0);
  const [mode, setMode] = useState<"reporter" | "dataset">("reporter");

  useEffect(() => {
    if (window.location.search.includes("mode=dataset")) setMode("dataset");
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultsEndRef = useRef<HTMLDivElement>(null);
  const hasResults = results.length > 0;
  const canSend = !pending && file !== null;
  const sorted = [...results].reverse();
  const activeResult = selectedId ? results.find(r => r.id === selectedId) : (results.length > 0 ? results[results.length - 1] : null);

  const addToast = useCallback((type: Toast["type"], title: string, message?: string) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setFilePreviewUrl(url);
      setSelectedId(null);
      return () => URL.revokeObjectURL(url);
    }
    setFilePreviewUrl(null);
  }, [file]);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) { setFile(f); e.preventDefault(); break; }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    function onDragOver(e: DragEvent) {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setIsDragActive(true);
      }
    }
    function onDragEnter(e: DragEvent) {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setDragCounter(c => c + 1);
        setIsDragActive(true);
      }
    }
    function onDragLeave(e: DragEvent) {
      if (!e.relatedTarget) {
        setDragCounter(c => {
          const next = c - 1;
          if (next <= 0) setIsDragActive(false);
          return Math.max(0, next);
        });
      }
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      setIsDragActive(false);
      setDragCounter(0);
      if (e.dataTransfer) {
        const f = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("image/"));
        if (f) setFile(f);
      }
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.repeat) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (!canSend) return;
      e.preventDefault();
      sendMessage();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSend, file]);

  useEffect(() => { resultsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [results]);

  useEffect(() => {
    if (results.length > 0 && !expandedId) {
      setExpandedId(results[results.length - 1].id);
      setSelectedId(results[results.length - 1].id);
    }
  }, [results.length]);

  async function sendMessage() {
    if (!canSend || !file) return;
    setPending(true);
    const imageUrl = URL.createObjectURL(file);
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("message", "Analyze this image");
    form.append("image", file);

    try {
      const res = await fetch(`${API_BASE}/api/chat/analyze`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);
      const payload = (await res.json()) as AssistantPayload;
      setResults(prev => [...prev, { id: crypto.randomUUID(), imageUrl, timestamp: Date.now(), payload }]);
      setFile(null);
    } catch (error) {
      addToast("error", "Analysis Failed", error instanceof Error ? error.message : "Could not connect to server. Check that the backend is running.");
      setFile(null);
    } finally { setPending(false); }
  }

  async function reportIncident(result: AnalysisResult) {
    const confirmed = window.confirm("Send a report to authorities for this incident?");
    if (!confirmed) return;
    const notifyWhatsapp = window.confirm("Also alert via WhatsApp?");
    try {
      const res = await fetch(`${API_BASE}/api/actions/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message_id: result.id,
          reason: "User-confirmed hazard report",
          incident_summary: extractSummary(result.payload.reply),
          place_guess: result.payload.location_name || result.payload.place_guess,
          confirm: true,
          notify_whatsapp: notifyWhatsapp,
        }),
      });
      const data = await res.json();
      const whatsapp = data?.whatsapp?.sent ? "WhatsApp alert sent." : `WhatsApp: ${data?.whatsapp?.reason ?? "not requested"}.`;
      addToast("success", "Report Submitted", `ID: ${data.incident_id}\n${whatsapp}`);
    } catch {
      addToast("error", "Report Failed", "Could not submit report to authorities.");
    }
  }

  async function learnMore(query: string) {
    try {
      const res = await fetch(`${API_BASE}/api/actions/learn-more?query=${encodeURIComponent(query)}`);
      const data = await res.json();
      const summary = data?.summary || "No summary available.";
      addToast("info", data?.title || query, summary);
    } catch { addToast("error", "Search Failed"); }
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#0f0f0f", color: "#e8e6e3" }}>
      <ToastContainer toasts={toasts} onDismiss={removeToast} />

      {isDragActive && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="animate-slide-up rounded-2xl border-2 border-dashed px-14 py-12 text-center"
            style={{
              borderColor: "rgba(239,68,68,0.4)",
              background: "rgba(239,68,68,0.06)",
              boxShadow: "0 0 60px rgba(239,68,68,0.06)",
            }}>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl" style={{ background: "rgba(239,68,68,0.12)" }}>
              <ImageUp className="h-7 w-7" style={{ color: "#ef4444" }} />
            </div>
            <p className="text-lg font-bold" style={{ color: "#e8e6e3" }}>Drop to analyze</p>
            <p className="mt-1 text-sm" style={{ color: "#a3a3a3" }}>Photo will be scanned for hazards and location</p>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className={`${showHistory ? "w-72" : "w-0"} flex-shrink-0 border-r transition-all duration-300 overflow-hidden`} style={{ borderColor: "#1c1c1c", background: "#0f0f0f" }}>
        <div className="flex h-full flex-col" style={{ minWidth: "16rem" }}>
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "#1c1c1c" }}>
            <div className="flex items-center gap-2">
              <History className="h-4 w-4" style={{ color: "#525252" }} />
              <span className="text-sm font-semibold" style={{ color: "#d1d5db" }}>Incidents</span>
              {results.length > 0 && (
                <span className="ml-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium font-mono" style={{ background: "#1c1c1c", color: "#a3a3a3" }}>
                  {results.length}
                </span>
              )}
            </div>
            <button onClick={() => setShowHistory(false)} className="rounded-lg p-1.5 transition-colors hover:bg-surface-hover" style={{ color: "#525252" }}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {results.length === 0 ? (
              <div className="mt-12 text-center">
                <p className="text-xs" style={{ color: "#525252" }}>No incidents recorded</p>
              </div>
            ) : (
              [...results].reverse().map(r => {
                const rc = riskConfig(r.payload.risk_level);
                const isActive = r.id === (activeResult?.id);
                return (
                  <button key={r.id} onClick={() => { setSelectedId(r.id); setExpandedId(r.id); }}
                    className="w-full rounded-xl p-2.5 text-left transition-all duration-150"
                    style={{
                      background: isActive ? rc.bg : "transparent",
                      border: `1px solid ${isActive ? rc.border : "transparent"}`,
                      boxShadow: isActive ? rc.glow : "none",
                    }}>
                    <div className="flex items-start gap-2.5">
                      <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-lg" style={{ background: "#161616" }}>
                        <img src={r.imageUrl} alt="" className="h-full w-full object-cover" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" style={{ color: "#e8e6e3" }}>
                          {r.payload.location_name || r.payload.place_guess || "Unknown location"}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase font-mono"
                            style={{ background: rc.bg, color: rc.color }}>
                            <HazardIcon risk={r.payload.risk_level} />
                            {r.payload.risk_level}
                          </span>
                          <span className="text-[11px] font-mono" style={{ color: "#525252" }}>{formatTime(r.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between border-b px-4 py-2.5 md:px-6" style={{ borderColor: "#1c1c1c", background: "rgba(15,15,15,0.95)" }}>
          <div className="flex items-center gap-3">
            {mode === "reporter" && !showHistory && (
              <button onClick={() => setShowHistory(true)} className="rounded-lg p-1.5 transition-colors hover:bg-surface-hover" style={{ color: "#a3a3a3" }}>
                <History className="h-5 w-5" />
              </button>
            )}
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "rgba(239,68,68,0.12)" }}>
                <TriangleAlert className="h-4 w-4" style={{ color: "#ef4444" }} />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight" style={{ color: "#e8e6e3" }}>Hazard Lens</h1>
                <p className="text-[10px] uppercase tracking-[0.12em] font-mono" style={{ color: "#525252" }}>Incident Reporter</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <nav className="hidden sm:flex items-center rounded-lg border p-0.5" style={{ borderColor: "#262626", background: "#0f0f0f" }}>
              <button onClick={() => setMode("reporter")}
                className="rounded-md px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background: mode === "reporter" ? "#1c1c1c" : "transparent",
                  color: mode === "reporter" ? "#e8e6e3" : "#525252",
                }}>
                Reporter
              </button>
              <button onClick={() => setMode("dataset")}
                className="rounded-md px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background: mode === "dataset" ? "#1c1c1c" : "transparent",
                  color: mode === "dataset" ? "#e8e6e3" : "#525252",
                }}>
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5" />
                  Dataset
                </span>
              </button>
            </nav>
            {mode === "reporter" && hasResults && (
              <button onClick={() => setShowHistory(!showHistory)}
                className="hidden md:inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover"
                style={{ color: "#a3a3a3" }}>
                {showHistory ? "Hide" : "History"}
              </button>
            )}
          </div>
        </header>

        {/* Body */}
        <main className="flex-1 overflow-y-auto">
          {mode === "dataset" ? (
            <DatasetViewer apiBase={API_BASE} />
          ) : (<>
            {!hasResults ? (
            pending ? (
              <div className="flex min-h-[calc(100vh-56px)] items-center justify-center p-4">
                <div className="w-full max-w-md text-center">
                  <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: "rgba(239,68,68,0.1)" }}>
                    <Loader2 className="h-7 w-7 animate-spin" style={{ color: "#ef4444" }} />
                  </div>
                  <h2 className="text-xl font-bold tracking-tight" style={{ color: "#e8e6e3" }}>Analyzing incident</h2>
                  <p className="mt-2 text-sm" style={{ color: "#a3a3a3" }}>
                    AI is examining the photo for hazards and identifying the location.
                  </p>
                  <div className="mt-8 space-y-3">
                    <SkeletonCard />
                    <SkeletonCard />
                  </div>
                  {filePreviewUrl && (
                    <img src={filePreviewUrl} alt="" className="mx-auto mt-6 max-h-40 rounded-xl object-contain opacity-30" />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[calc(100vh-56px)] items-center justify-center p-4">
                <div className="w-full max-w-md text-center">
                  <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: "rgba(239,68,68,0.1)" }}>
                    <TriangleAlert className="h-8 w-8" style={{ color: "#ef4444" }} />
                  </div>
                  <h2 className="text-2xl font-bold tracking-tight" style={{ color: "#e8e6e3" }}>Hazard Lens</h2>
                  <p className="mt-2 text-sm leading-relaxed" style={{ color: "#a3a3a3" }}>
                    Upload a photo of an incident — flood, fire, accident — to identify the location and report it to authorities.
                  </p>

                  <div className="mt-10 rounded-2xl border-2 border-dashed p-8 transition-all duration-300"
                    style={{
                      borderColor: file ? "rgba(239,68,68,0.3)" : "#1c1c1c",
                      background: file ? "rgba(239,68,68,0.04)" : "transparent",
                    }}
                    onClick={() => !file && fileInputRef.current?.click()}>
                    {file && filePreviewUrl ? (
                      <div className="space-y-5">
                        <div className="relative mx-auto overflow-hidden rounded-xl">
                          <img src={filePreviewUrl} alt="Preview" className="mx-auto max-h-56 rounded-xl object-contain" />
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3 pt-8">
                            <p className="text-left text-xs font-medium text-white/90 truncate">{file.name}</p>
                            <p className="text-left text-[11px] font-mono text-white/60">{formatFileSize(file.size)}</p>
                          </div>
                        </div>
                        <div className="flex justify-center gap-3">
                          <button onClick={(e) => { e.stopPropagation(); sendMessage(); }}
                            disabled={!canSend}
                            className="inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold transition-all active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                            style={{ background: "#ef4444", color: "#fff" }}>
                            {pending ? (
                              <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing...</>
                            ) : (
                              <><ImageUp className="h-4 w-4" /> Analyze Incident</>
                            )}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setFile(null); }}
                            className="rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-surface-hover active:scale-[0.97]"
                            style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="cursor-pointer space-y-4">
                        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl transition-colors" style={{ background: "#161616" }}>
                          <Plus className="h-6 w-6" style={{ color: "#525252" }} />
                        </div>
                        <div>
                          <p className="text-base font-semibold" style={{ color: "#d1d5db" }}>Upload an incident photo</p>
                          <p className="mt-1 text-xs" style={{ color: "#525252" }}>Drag &amp; drop, paste, or click to browse</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="mx-auto max-w-3xl space-y-3 p-4 md:p-6">
              {sorted.map((result, index) => {
                const isExpanded = expandedId === result.id;
                const rc = riskConfig(result.payload.risk_level);
                const summary = extractSummary(result.payload.reply);
                const hasCoords = result.payload.latitude && result.payload.longitude;
                const p = result.payload;
                const locParts = [p.area, p.district, p.state, p.country].filter(Boolean);

                return (
                  <article key={result.id} className="overflow-hidden rounded-2xl border transition-all duration-200"
                    style={{
                      borderColor: isExpanded ? rc.border : "#1c1c1c",
                      background: "#161616",
                      animation: `slide-up 0.4s ease-out ${index * 0.06}s both`,
                    }}>
                    {/* Collapsed header */}
                    <div className="flex items-center gap-3 p-3 cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : result.id)}
                      onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                      onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = ""; }}>
                      <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl" style={{ background: "#0f0f0f" }}>
                        <img src={result.imageUrl} alt="" className="h-full w-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${rc.label === "HIGH ALERT" ? "animate-pulse-glow" : ""}`}
                            style={{ background: rc.bg, color: rc.color, border: `1px solid ${rc.border}` }}>
                            <HazardIcon risk={p.risk_level} />
                            {rc.label}
                          </span>
                          <span className="text-[11px] font-mono" style={{ color: "#525252" }}>· {(p.confidence * 100).toFixed(0)}%</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium" style={{ color: "#e8e6e3" }}>
                          {p.location_name || p.place_guess || "Analyzing..."}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className="text-[11px] font-mono" style={{ color: "#525252" }}>{formatTime(result.timestamp)}</p>
                        <ChevronRight className={`ml-auto mt-1 h-4 w-4 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} style={{ color: "#525252" }} />
                      </div>
                    </div>

                    {/* Expanded content */}
                    <div className={`expand-content ${isExpanded ? "open" : ""}`}>
                      <div>
                        <div className="border-t px-3 pb-4 pt-3 space-y-4" style={{ borderColor: "#1c1c1c" }}
                          onClick={(e) => e.stopPropagation()}>

                          {/* Image + Map */}
                          <div className="flex flex-col gap-3 md:flex-row">
                            <div className="relative w-full md:w-1/2">
                              <img src={result.imageUrl} alt="Incident" className="h-44 w-full rounded-xl object-cover md:h-48" />
                            </div>
                            <div className="w-full md:w-1/2">
                              {hasCoords ? <MiniMap lat={p.latitude!} lng={p.longitude!} />
                                : (
                                  <div className="flex h-44 items-center justify-center rounded-xl md:h-48" style={{ background: "#0f0f0f" }}>
                                    <div className="text-center" style={{ color: "#525252" }}>
                                      <Crosshair className="mx-auto mb-2 h-8 w-8 opacity-40" />
                                      <p className="text-xs font-mono">No location data</p>
                                    </div>
                                  </div>
                                )}
                            </div>
                          </div>

                          {/* Location hierarchy */}
                          {[p.area, p.district, p.state].some(Boolean) ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5 text-xs font-mono" style={{ color: "#525252" }}>
                                {locParts.map((part, i) => (
                                  <span key={i} className="inline-flex items-center gap-1.5">
                                    {i > 0 && <span className="text-surface-border">›</span>}
                                    <span style={{ color: i === 0 ? "#d1d5db" : "#a3a3a3" }}>{part}</span>
                                  </span>
                                ))}
                              </div>
                              {p.formatted_address && (
                                <p className="text-xs" style={{ color: "#525252" }}>{p.formatted_address}</p>
                              )}
                              {hasCoords && (
                                <p className="text-xs font-mono" style={{ color: "#525252" }}>
                                  {p.latitude!.toFixed(5)}, {p.longitude!.toFixed(5)}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div>
                              {p.location_name && (
                                <h3 className="text-base font-semibold tracking-tight" style={{ color: "#e8e6e3" }}>{p.location_name}</h3>
                              )}
                              {p.formatted_address && (
                                <p className="mt-0.5 text-sm" style={{ color: "#a3a3a3" }}>{p.formatted_address}</p>
                              )}
                              {p.place_guess && !p.formatted_address && (
                                <p className="mt-0.5 text-sm" style={{ color: "#a3a3a3" }}>{p.place_guess}</p>
                              )}
                              {hasCoords && (
                                <p className="mt-0.5 text-xs font-mono" style={{ color: "#525252" }}>
                                  {p.latitude!.toFixed(5)}, {p.longitude!.toFixed(5)}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Analysis */}
                          <p className="text-sm leading-relaxed" style={{ color: "#d1d5db" }}>{summary}</p>

                          {/* EXIF */}
                          {(p.exif_timestamp || p.exif_camera) && (
                            <div className="flex flex-wrap gap-3 text-xs font-mono" style={{ color: "#525252" }}>
                              {p.exif_timestamp && <span className="inline-flex items-center gap-1.5"><Clock className="h-3 w-3" />{p.exif_timestamp}</span>}
                              {p.exif_camera && <span className="inline-flex items-center gap-1.5"><Camera className="h-3 w-3" />{p.exif_camera}</span>}
                            </div>
                          )}

                          {/* Entities */}
                          {p.entities?.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {p.entities.map((e, i) => (
                                <span key={i} className="rounded-full px-2.5 py-1 text-xs transition-colors hover:bg-surface-hover" style={{ background: "#1c1c1c", color: "#a3a3a3" }}>{e}</span>
                              ))}
                            </div>
                          )}

                          {/* Actions */}
                          <div className="flex flex-wrap gap-2 pt-1">
                            {p.risk_level === "high" || p.risk_level === "medium" ? (
                              <button onClick={() => reportIncident(result)}
                                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wider transition-all active:scale-[0.97]"
                                style={{ background: "#ef4444", color: "#fff" }}>
                                <Send className="h-3.5 w-3.5" />
                                Report to Authorities
                              </button>
                            ) : null}
                            <button onClick={() => { const q = p.place_guess || p.location_name || (p.entities?.[0]); if (q) learnMore(q); }}
                              className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all hover:bg-surface-hover active:scale-[0.97]"
                              style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                              <ExternalLink className="h-3.5 w-3.5" />
                              Learn More
                            </button>
                            {hasCoords && (
                              <button onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`, "_blank")}
                                className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all hover:bg-surface-hover active:scale-[0.97]"
                                style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                                <MapPin className="h-3.5 w-3.5" />
                                Open Map
                              </button>
                            )}
                            <button onClick={() => addToast("info", "Safety Tips",
                              "Remain at a safe distance. Avoid confrontation. Contact nearby security staff. Report only verified concerns. Do not enter hazardous areas.")}
                              className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all hover:bg-surface-hover active:scale-[0.97]"
                              style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                              <ShieldAlert className="h-3.5 w-3.5" />
                              Safety Tips
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}

              {pending && (
                <div className="animate-slide-up overflow-hidden rounded-2xl border" style={{ borderColor: "#1c1c1c" }}>
                  <SkeletonCard />
                </div>
              )}
              <div ref={resultsEndRef} />
            </div>
          )}
          </>)}
        </main>

        {/* Bottom upload bar */}
        {mode === "reporter" && hasResults && (
          <div className="border-t px-4 py-3 md:px-6" style={{ borderColor: "#1c1c1c", background: "rgba(15,15,15,0.95)" }}>
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              {file && filePreviewUrl ? (
                <>
                  <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg" style={{ background: "#161616" }}>
                    <img src={filePreviewUrl} alt="" className="h-full w-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium" style={{ color: "#d1d5db" }}>{file.name}</p>
                    <p className="text-[11px] font-mono" style={{ color: "#525252" }}>{formatFileSize(file.size)}</p>
                  </div>
                  <button onClick={sendMessage} disabled={!canSend}
                    className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                    style={{ background: "#ef4444", color: "#fff" }}>
                    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Analyze"}
                  </button>
                  <button onClick={() => setFile(null)}
                    className="rounded-xl border px-3 py-2 text-xs font-medium transition-colors hover:bg-surface-hover active:scale-[0.97]"
                    style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                    Clear
                  </button>
                </>
              ) : (
                <button onClick={() => fileInputRef.current?.click()}
                  className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-2.5 text-sm transition-all"
                  style={{ borderColor: "#262626", color: "#a3a3a3" }}>
                  <Plus className="h-4 w-4 transition-transform group-hover:scale-110" />
                  <span>Upload new incident photo</span>
                  <span className="ml-1 hidden text-xs md:inline font-mono" style={{ color: "#525252" }}>or paste / drag &amp; drop</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const n = e.target.files?.[0] ?? null; if (n) setFile(n); e.target.value = ""; }} />
    </div>
  );
}
