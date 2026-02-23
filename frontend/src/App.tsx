import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, MapPin, Plus, ShieldAlert } from "lucide-react";
import { Button } from "./components/ui/button";

type Risk = "low" | "medium" | "high" | "uncertain";
type ActionType =
  | "report"
  | "learn_more"
  | "open_map"
  | "safety_tips"
  | "why"
  | "ask_for_context";

type ActionItem = {
  type: ActionType;
  label: string;
  payload?: Record<string, string>;
};

type AssistantPayload = {
  reply: string;
  risk_level: Risk;
  confidence: number;
  entities: string[];
  location_name: string | null;
  place_guess: string | null;
  actions: ActionItem[];
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
  payload?: AssistantPayload;
  metaType?: "why_result";
  sourceMessageId?: string;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

function riskStyle(risk: Risk) {
  if (risk === "high") return "bg-red-100 text-red-700";
  if (risk === "medium") return "bg-amber-100 text-amber-800";
  if (risk === "low") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-700";
}

function extractRationale(replyText: string) {
  const marker = "Reasoning:";
  const idx = replyText.indexOf(marker);
  if (idx === -1) return "Model rationale was unavailable.";
  const rationale = replyText.slice(idx + marker.length).trim();
  return rationale || "Model rationale was unavailable.";
}

function extractSummary(replyText: string) {
  const marker = "\n\nReasoning:";
  const idx = replyText.indexOf(marker);
  if (idx === -1) return replyText.trim();
  const summary = replyText.slice(0, idx).trim();
  return summary || replyText.trim();
}

function isGenericLearnMoreQuery(query: string | undefined) {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  return (
    normalized === "landmark" ||
    normalized === "place" ||
    normalized === "location" ||
    normalized === "tourist place" ||
    normalized === "historic place"
  );
}

export default function App() {
  const [sessionId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const intakeCardRef = useRef<HTMLDivElement | null>(null);
  const hasMessages = messages.length > 0;
  const canSend = !pending && file !== null;

  function focusIntakeCard() {
    intakeCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleIncomingImage(nextFile: File) {
    setFile(nextFile);
    requestAnimationFrame(() => {
      focusIntakeCard();
    });
  }

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const pastedFile = item.getAsFile();
          if (pastedFile) {
            handleIncomingImage(pastedFile);
            event.preventDefault();
            break;
          }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    if (focusMessageId) {
      document
        .getElementById(`msg-${focusMessageId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setFocusMessageId(null);
      return;
    }
    if (hasMessages) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [focusMessageId, hasMessages, messages]);

  useEffect(() => {
    function onDragOver(event: DragEvent) {
      if (!event.dataTransfer) return;
      if (Array.from(event.dataTransfer.types).includes("Files")) {
        event.preventDefault();
        setIsDragActive(true);
      }
    }

    function onDragLeave(event: DragEvent) {
      if (!event.relatedTarget) setIsDragActive(false);
    }

    function onDrop(event: DragEvent) {
      if (!event.dataTransfer) return;
      event.preventDefault();
      setIsDragActive(false);
      const dropped = Array.from(event.dataTransfer.files).find((f) =>
        f.type.startsWith("image/"),
      );
      if (dropped) handleIncomingImage(dropped);
    }

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (!canSend) return;
      event.preventDefault();
      void sendMessage();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSend]);

  async function sendMessage() {
    if (!canSend) return;

    setPending(true);
    const imageUrl = file ? URL.createObjectURL(file) : undefined;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: "",
      imageUrl,
    };

    setMessages((prev) => [...prev, userMessage]);
    setFocusMessageId(userMessage.id);

    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("message", "Analyze this image");
    if (file) form.append("image", file);

    setFile(null);

    try {
      const res = await fetch(`${API_BASE}/api/chat/analyze`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);
      const payload = (await res.json()) as AssistantPayload;

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: payload.reply,
          payload,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  async function handleAction(message: Message, action: ActionItem) {
    if (!message.payload) return;

    if (action.type === "learn_more") {
      const actionQuery = action.payload?.query;
      const query =
        message.payload.location_name ||
        message.payload.place_guess ||
        (!isGenericLearnMoreQuery(actionQuery) ? actionQuery : undefined) ||
        message.payload.entities.find((entity) => !isGenericLearnMoreQuery(entity)) ||
        message.payload.entities[0] ||
        "landmark";
      const res = await fetch(
        `${API_BASE}/api/actions/learn-more?query=${encodeURIComponent(query)}`,
      );
      const data = await res.json();
      const title = typeof data?.title === "string" && data.title ? data.title : query;
      const summary =
        typeof data?.summary === "string" && data.summary
          ? data.summary
          : "No summary was returned for this topic.";
      const url =
        typeof data?.url === "string" && data.url
          ? data.url
          : `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `${title}\n${summary}\n${url}`,
        },
      ]);
      return;
    }

    if (action.type === "report") {
      const confirmed = window.confirm(
        "Create a suspicious activity report for this response?",
      );
      if (!confirmed) return;
      const notifyWhatsapp = window.confirm(
        "Also send this report to the configured authority WhatsApp number?",
      );

      const res = await fetch(`${API_BASE}/api/actions/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message_id: message.id,
          reason: "User-confirmed suspicious activity report",
          incident_summary: extractSummary(message.text),
          place_guess: message.payload.location_name || message.payload.place_guess,
          confirm: true,
          notify_whatsapp: notifyWhatsapp,
        }),
      });
      const data = await res.json();
      const whatsappLine = data?.whatsapp?.sent
        ? "WhatsApp alert sent to authority."
        : `WhatsApp alert not sent (${data?.whatsapp?.reason ?? "not requested"}).`;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Report logged successfully. Incident ID: ${data.incident_id}\n${whatsappLine}`,
        },
      ]);
      return;
    }

    if (action.type === "open_map") {
      const mapQuery =
        action.payload?.query ||
        message.payload.location_name ||
        message.payload.place_guess;
      if (mapQuery) {
        window.open(
          `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`,
          "_blank",
        );
      }
      return;
    }

    if (action.type === "safety_tips") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Safety tips: remain at a safe distance, avoid confrontation, contact nearby security staff, and report only verified concerns.",
        },
      ]);
      return;
    }

    if (action.type === "why") {
      const existingWhy = messages.find(
        (msg) =>
          msg.metaType === "why_result" &&
          msg.sourceMessageId === message.id,
      );
      if (existingWhy) {
        setFocusMessageId(existingWhy.id);
        return;
      }

      const payload = message.payload;
      const rationale = extractRationale(message.text ?? "");
      const entities = payload?.entities?.length
        ? payload.entities.slice(0, 4).join(", ")
        : "No strong entities detected.";
      const place = payload?.place_guess ?? "Not confidently identified.";
      const canonicalPlace = payload?.location_name ?? "Not available.";
      const risk = payload?.risk_level ?? "uncertain";
      const confidencePct = ((payload?.confidence ?? 0) * 100).toFixed(0);
      const reasonText = [
        `Risk level: ${risk}`,
        `Confidence: ${confidencePct}%`,
        `Canonical location: ${canonicalPlace}`,
        `Detected entities: ${entities}`,
        `Place guess: ${place}`,
        `Rationale: ${rationale}`,
      ].join("\n");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Why this result:\n${reasonText}`,
          metaType: "why_result",
          sourceMessageId: message.id,
        },
      ]);
    }
  }

  const ImageIntakeCard = (
    <>
      {file && filePreviewUrl ? (
        <div className="rounded-2xl border border-[#3f3f3f] bg-[#2a2a2a] p-3">
          <img
            src={filePreviewUrl}
            alt="Pending upload preview"
            className="h-72 w-full cursor-zoom-in rounded-xl border border-[#4a4a4a] bg-[#1f1f1f] object-contain"
            onClick={() => setLightboxUrl(filePreviewUrl)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              className="bg-[#3a3a3a] text-[#ececec] hover:bg-[#4a4a4a]"
              onClick={() => void sendMessage()}
              disabled={!canSend}
            >
              {pending ? "Analyzing..." : "Analyze"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-[#4a4a4a] bg-[#2a2a2a] text-[#ececec] hover:bg-[#373737]"
              onClick={() => fileInputRef.current?.click()}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-[#4a4a4a] bg-[#2a2a2a] text-[#ececec] hover:bg-[#373737]"
              onClick={() => setFile(null)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#4a4a4a] bg-[#2a2a2a] p-8 text-center">
          <p className="mb-4 text-sm text-[#cfcfcf]">
            Upload, paste, or drag an image to analyze
          </p>
          <Button
            type="button"
            className="mx-auto bg-[#3a3a3a] text-[#ececec] hover:bg-[#4a4a4a]"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="mr-2 h-4 w-4" />
            Upload Image
          </Button>
        </div>
      )}
      <div className="hidden">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const next = e.target.files?.[0] ?? null;
            if (next) {
              handleIncomingImage(next);
            } else {
              setFile(null);
            }
          }}
        />
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-[#212121] text-[#ececec]">
      <div className="pointer-events-none fixed left-5 top-5 z-20 text-sm font-semibold tracking-wide text-[#e7e7e7]">
        Vision GPT
      </div>

      {isDragActive ? (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/45 backdrop-blur-[1px]">
          <div className="rounded-2xl border border-[#5a5a5a] bg-[#2c2c2c] px-6 py-4 text-sm font-medium text-[#efefef]">
            Drop image to upload
          </div>
        </div>
      ) : null}

      {lightboxUrl ? (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/80 p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Full preview"
            className="max-h-[90vh] max-w-[92vw] rounded-xl border border-[#5a5a5a] bg-[#1f1f1f] object-contain"
          />
        </div>
      ) : null}

      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-4 pb-6 pt-10 md:px-6">
        {hasMessages ? (
          <>
            <div className="mb-6 flex-1 space-y-5 overflow-y-auto pb-8">
              {messages.map((msg) => {
                const isUserImageOnly = msg.role === "user" && !msg.text && !!msg.imageUrl;
                return (
                <article
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`w-full ${msg.role === "user" ? `ml-auto max-w-[78%] rounded-2xl bg-[#2f2f2f] ${isUserImageOnly ? "p-1" : "px-4 py-3"}` : "max-w-[85%] px-1"}`}
                >
                  {msg.text ? (
                    <p className="whitespace-pre-wrap text-[15px] leading-6 text-[#ececec]">
                      {msg.text}
                    </p>
                  ) : null}
                  {msg.imageUrl ? (
                    <img
                      src={msg.imageUrl}
                      alt="uploaded"
                      className={`${msg.text ? "mt-3" : ""} max-h-72 cursor-zoom-in rounded-xl border border-[#3a3a3a] bg-[#1f1f1f] object-contain`}
                      onClick={() => setLightboxUrl(msg.imageUrl || null)}
                    />
                  ) : null}

                  {msg.payload ? (
                    <div className="mt-3 space-y-2 text-xs text-[#bcbcbc]">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-1 font-semibold ${riskStyle(msg.payload.risk_level)}`}
                        >
                          risk: {msg.payload.risk_level}
                        </span>
                        <span>
                          confidence: {(msg.payload.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {msg.payload.actions.map((action) => (
                          <Button
                            key={`${msg.id}-${action.type}`}
                            size="sm"
                            variant={
                              action.type === "report" ? "destructive" : "outline"
                            }
                            className="border-[#4a4a4a] bg-[#2a2a2a] text-[#ececec] hover:bg-[#373737]"
                            onClick={() => handleAction(msg, action)}
                          >
                            {action.type === "report" ? (
                              <AlertTriangle className="mr-1 h-4 w-4" />
                            ) : null}
                            {action.type === "learn_more" ? (
                              <BookOpen className="mr-1 h-4 w-4" />
                            ) : null}
                            {action.type === "open_map" ? (
                              <MapPin className="mr-1 h-4 w-4" />
                            ) : null}
                            {action.type === "safety_tips" ? (
                              <ShieldAlert className="mr-1 h-4 w-4" />
                            ) : null}
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              );})}
              {pending ? (
                <article className="max-w-[85%] px-1">
                  <div className="inline-flex items-center gap-2 rounded-2xl bg-[#2a2a2a] px-4 py-3 text-sm text-[#d5d5d5]">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#bdbdbd]" />
                    Analyzing image, this may take a few seconds...
                  </div>
                </article>
              ) : null}
              <div ref={messagesEndRef} />
            </div>

            <div ref={intakeCardRef} className="mx-auto w-full max-w-3xl">
              {ImageIntakeCard}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div ref={intakeCardRef} className="w-full max-w-3xl">
              <h1 className="mb-8 text-center text-4xl font-medium tracking-tight text-[#e7e7e7] md:text-5xl">
                Welcome to Vision GPT!
              </h1>
              {ImageIntakeCard}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
