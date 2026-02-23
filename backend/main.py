from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import requests
import wikipedia
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from pydantic import BaseModel, ConfigDict, ValidationError, conint, constr
from wikipedia.exceptions import DisambiguationError, PageError, WikipediaException

load_dotenv()

app = Flask(__name__)
CORS(app)

DB_PATH = os.getenv("DATABASE_PATH", "./data/visiongpt.db")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "10"))
ENABLE_WHATSAPP_NOTIFY = os.getenv("ENABLE_WHATSAPP_NOTIFY", "false").lower() == "true"
WHAPI_BASE_URL = os.getenv("WHAPI_BASE_URL", "https://gate.whapi.cloud")
WHAPI_TOKEN = os.getenv("WHAPI_TOKEN", "")
AUTHORITY_WHATSAPP_TO = os.getenv("AUTHORITY_WHATSAPP_TO", "")
REPORT_RATE_LIMIT_WINDOW_SEC = int(os.getenv("REPORT_RATE_LIMIT_WINDOW_SEC", "60"))
REPORT_RATE_LIMIT_MAX = int(os.getenv("REPORT_RATE_LIMIT_MAX", "5"))
REPORT_DUPLICATE_WINDOW_SEC = int(os.getenv("REPORT_DUPLICATE_WINDOW_SEC", "300"))
LEARN_MORE_MIN_QUERY_LEN = int(os.getenv("LEARN_MORE_MIN_QUERY_LEN", "2"))
LEARN_MORE_MAX_QUERY_LEN = int(os.getenv("LEARN_MORE_MAX_QUERY_LEN", "120"))

_report_rate_limiter: dict[str, list[float]] = defaultdict(list)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              text TEXT NOT NULL,
              image_hash TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS model_outputs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              message_id TEXT NOT NULL,
              risk_level TEXT NOT NULL,
              confidence REAL NOT NULL,
              json_payload TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incidents (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL,
              message_id TEXT NOT NULL,
              reason TEXT NOT NULL,
              confirmed_by_user INTEGER NOT NULL,
              whatsapp_attempted INTEGER NOT NULL DEFAULT 0,
              whatsapp_sent INTEGER NOT NULL DEFAULT 0,
              whatsapp_reason TEXT NOT NULL DEFAULT 'not_requested',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS actions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              message_id TEXT NOT NULL,
              action_type TEXT NOT NULL,
              payload TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_incidents_session_created ON incidents(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_incidents_dedupe ON incidents(session_id, message_id, reason, created_at);
            CREATE INDEX IF NOT EXISTS idx_actions_message_created ON actions(message_id, created_at);
            """
        )
        # Migration-safe column backfill for older local DBs.
        _ensure_column(conn, "incidents", "whatsapp_attempted", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "incidents", "whatsapp_sent", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "incidents", "whatsapp_reason", "TEXT NOT NULL DEFAULT 'not_requested'")


def _save_message(
    message_id: str,
    session_id: str,
    role: str,
    text: str,
    image_hash: str | None = None,
) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)",
            (session_id, _now()),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, text, image_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, session_id, role, text, image_hash, _now()),
        )


def _save_model_output(message_id: str, risk_level: str, confidence: float, payload: dict[str, Any]) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO model_outputs (message_id, risk_level, confidence, json_payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (message_id, risk_level, confidence, json.dumps(payload), _now()),
        )


def _log_action(message_id: str, action_type: str, payload: dict[str, Any]) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO actions (message_id, action_type, payload, created_at) VALUES (?, ?, ?, ?)",
            (message_id, action_type, json.dumps(payload), _now()),
        )


def _extract_json(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    # Handle model responses like ```json ... ```
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = text[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _gemini_generate(parts: list[dict[str, Any]]) -> str | None:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
        },
    }
    resp = requests.post(url, json=body, timeout=25)
    if resp.status_code != 200:
        return None
    data = resp.json()
    return (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text")
    )


def _repair_json_once(raw_text: str) -> dict[str, Any] | None:
    if not raw_text:
        return None
    repair_prompt = (
        "Convert the following content into valid JSON only. "
        "Do not add explanation. Preserve intent and keys.\n\n"
        + raw_text
    )
    repaired_text = _gemini_generate([{"text": repair_prompt}])
    if not repaired_text:
        return None
    return _extract_json(repaired_text)


def _gemini_structured(prompt: str, image_b64: str | None, mime_type: str | None) -> dict[str, Any] | None:
    if not GEMINI_API_KEY:
        return None

    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image_b64 and mime_type:
        parts.append({"inline_data": {"mime_type": mime_type, "data": image_b64}})

    try:
        text = _gemini_generate(parts)
        parsed = _extract_json(text or "")
        if parsed:
            return parsed
        return _repair_json_once(text or "")
    except Exception:
        return None


def _fallback(message: str) -> dict[str, Any]:
    risk = "medium" if any(k in message.lower() for k in ["fight", "weapon", "blood"]) else "uncertain"
    confidence = 0.5 if risk == "medium" else 0.0
    return {
        "summary": "Model output was unavailable or invalid. This is a cautious fallback.",
        "risk_level": risk,
        "confidence": confidence,
        "entities": [],
        "location_name": None,
        "possible_location": None,
        "rationale": "Fallback due to unavailable structured response.",
    }


def _contains_hazard_signal(text: str) -> bool:
    lowered = text.lower()
    hazard_terms = [
        "fire",
        "flame",
        "burning",
        "smoke",
        "explosion",
        "flood",
        "water disaster",
        "drowning",
        "weapon",
        "gun",
        "knife",
        "blood",
        "fight",
        "assault",
        "collapse",
        "injured",
    ]
    return any(term in lowered for term in hazard_terms)


def _extract_place_from_summary(summary: str) -> str | None:
    if not summary:
        return None
    patterns = [
        r"identified as ([^.,;\n]+)",
        r"likely ([^.,;\n]+)",
        r"appears to be ([^.,;\n]+)",
        r"appears as ([^.,;\n]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, summary, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip(" .")
            if candidate and len(candidate) >= 3:
                return candidate
    return None


def _clean_location_name(raw_value: str | None) -> str | None:
    if not raw_value:
        return None
    value = raw_value.strip()
    value = re.sub(r"\([^)]*\)", "", value).strip(" ,.")
    value = re.sub(r"\b(based on|identified as|likely|possibly|specifically)\b.*$", "", value, flags=re.IGNORECASE).strip(" ,.")
    if not value:
        return None
    # Keep canonical name compact for wiki/maps queries.
    if "," in value:
        value = value.split(",", 1)[0].strip()
    if len(value) < 2:
        return None
    return value


def _normalize_structured_output(structured: dict[str, Any], user_message: str) -> dict[str, Any]:
    normalized = dict(structured)
    summary = str(normalized.get("summary", "")).strip()
    rationale = str(normalized.get("rationale", "")).strip()
    risk_level = str(normalized.get("risk_level", "uncertain")).lower().strip()
    confidence_raw = normalized.get("confidence", 0.0)

    try:
        if isinstance(confidence_raw, str):
            confidence_raw = confidence_raw.replace("%", "").strip()
            confidence = float(confidence_raw) / 100.0 if float(confidence_raw) > 1 else float(confidence_raw)
        else:
            confidence = float(confidence_raw or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0

    if risk_level not in {"low", "medium", "high", "uncertain"}:
        risk_level = "uncertain"
    confidence = max(0.0, min(1.0, confidence))

    location_name = _clean_location_name(
        str(normalized.get("location_name", "")).strip() if normalized.get("location_name") is not None else None
    )
    possible_location = normalized.get("possible_location")
    if possible_location is not None:
        possible_location = str(possible_location).strip()
    if not location_name:
        location_name = _clean_location_name(possible_location) or _clean_location_name(_extract_place_from_summary(summary))
    if not possible_location and location_name:
        possible_location = location_name
    if not possible_location:
        possible_location = _extract_place_from_summary(summary)

    signal_text = " ".join([summary, rationale, user_message, possible_location or ""]).strip()
    if _contains_hazard_signal(signal_text):
        if risk_level in {"low", "uncertain"}:
            risk_level = "high"
        confidence = max(confidence, 0.72)
        if not rationale:
            rationale = (
                "The description indicates possible hazardous activity. "
                "Please treat this as an unverified safety signal and verify context."
            )
    elif not rationale:
        rationale = "Model rationale was unavailable; result provided with cautious defaults."

    normalized["summary"] = summary or "Analysis complete."
    normalized["rationale"] = rationale
    normalized["risk_level"] = risk_level
    normalized["confidence"] = confidence
    normalized["location_name"] = location_name
    normalized["possible_location"] = possible_location
    return normalized


def _actions(
    risk_level: str,
    confidence: float,
    location_name: str | None,
    place_guess: str | None,
) -> list[dict[str, Any]]:
    if confidence < 0.45 or risk_level == "uncertain":
        return [
            {"type": "ask_for_context", "label": "Add More Context", "payload": {}},
            {"type": "why", "label": "Why this result?", "payload": {}},
        ]
    if risk_level == "high":
        return [
            {"type": "report", "label": "Report Suspicious Activity", "payload": {}},
            {"type": "safety_tips", "label": "Safety Tips", "payload": {}},
            {"type": "why", "label": "Why this result?", "payload": {}},
        ]
    if risk_level == "medium":
        return [
            {"type": "safety_tips", "label": "Safety Tips", "payload": {}},
            {"type": "why", "label": "Why this result?", "payload": {}},
        ]
    return [
        {"type": "learn_more", "label": "Learn More", "payload": {"query": location_name or place_guess or "landmark"}},
        {"type": "open_map", "label": "Open Map", "payload": {"query": location_name or place_guess or ""}},
        {"type": "why", "label": "Why this result?", "payload": {}},
    ]


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    session_id: constr(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    message_id: constr(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    reason: constr(min_length=3, max_length=500)
    incident_summary: constr(min_length=3, max_length=1000) | None = None
    place_guess: constr(min_length=2, max_length=200) | None = None
    confirm: bool
    notify_whatsapp: bool = False


class ListQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: conint(ge=1, le=100) = 50
    offset: conint(ge=0) = 0


def _send_whatsapp_alert(text: str) -> dict[str, Any]:
    if not WHAPI_TOKEN:
        return {"sent": False, "reason": "whapi_token_missing"}
    if not AUTHORITY_WHATSAPP_TO:
        return {"sent": False, "reason": "authority_number_missing"}

    url = f"{WHAPI_BASE_URL.rstrip('/')}/messages/text"
    headers = {
        "Authorization": f"Bearer {WHAPI_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    body = {"to": AUTHORITY_WHATSAPP_TO, "body": text}

    try:
        response = requests.post(url, json=body, headers=headers, timeout=15)
        if response.status_code >= 400:
            return {"sent": False, "reason": "whapi_error", "status_code": response.status_code}
        data = response.json() if response.content else {}
        return {"sent": True, "provider": "whapi", "response": data}
    except Exception:
        return {"sent": False, "reason": "whapi_exception"}


def _sanitize_wikipedia_query(raw_query: str) -> str | None:
    cleaned = " ".join((raw_query or "").split())
    if len(cleaned) < LEARN_MORE_MIN_QUERY_LEN or len(cleaned) > LEARN_MORE_MAX_QUERY_LEN:
        return None
    return cleaned


def _wikipedia_candidate_queries(query: str) -> list[str]:
    candidates: list[str] = []
    # Prefer an explicit "specifically X" hint when present.
    specifically_match = re.search(r"specifically\s+([^)]+)", query, flags=re.IGNORECASE)
    if specifically_match:
        specific = specifically_match.group(1).strip(" .")
        if specific:
            candidates.append(specific)

    # Remove parenthetical notes (often noisy qualifiers).
    deparen = re.sub(r"\([^)]*\)", "", query).strip(" ,.")
    if deparen:
        candidates.append(deparen)

    candidates.append(query)
    if "," in query:
        head = query.split(",", 1)[0].strip()
        if head:
            candidates.append(head)
    # De-duplicate while preserving order.
    return list(dict.fromkeys([candidate for candidate in candidates if candidate]))


def _wikipedia_page_payload(page: Any) -> dict[str, str] | None:
    title = str(getattr(page, "title", "")).strip()
    url = str(getattr(page, "url", "")).strip()
    if not title:
        return None
    try:
        summary = wikipedia.summary(title, sentences=3, auto_suggest=False, redirect=True).strip()
    except WikipediaException:
        summary = str(getattr(page, "summary", "")).strip()
    if not summary:
        return None
    return {"title": title, "summary": summary, "url": url}


def _title_match_score(query: str, title: str) -> int:
    q_tokens = {t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) > 2}
    t_tokens = {t for t in re.findall(r"[a-z0-9]+", title.lower()) if len(t) > 2}
    if not q_tokens or not t_tokens:
        return 0
    overlap = q_tokens & t_tokens
    return len(overlap)


def _resolve_wikipedia_page(query: str) -> dict[str, str] | None:
    # First attempt: exact page lookup without auto-suggest drift.
    try:
        exact_page = wikipedia.page(query, auto_suggest=False, redirect=True)
        exact_payload = _wikipedia_page_payload(exact_page)
        if exact_payload and _title_match_score(query, exact_payload["title"]) >= 1:
            return exact_payload
    except (DisambiguationError, PageError, WikipediaException):
        pass

    # Second attempt: ranked search results, keep only close lexical matches.
    try:
        results = wikipedia.search(query, results=8)
    except WikipediaException:
        results = []

    ranked_titles = sorted(results, key=lambda title: _title_match_score(query, title), reverse=True)
    for title in ranked_titles:
        if _title_match_score(query, title) < 1:
            continue
        try:
            page = wikipedia.page(title, auto_suggest=False, redirect=True)
            payload = _wikipedia_page_payload(page)
            if payload and _title_match_score(query, payload["title"]) >= 1:
                return payload
        except (DisambiguationError, PageError, WikipediaException):
            continue
    return None


def _fetch_wikipedia_summary(query: str) -> dict[str, str] | None:
    wikipedia.set_lang("en")
    for candidate in _wikipedia_candidate_queries(query):
        payload = _resolve_wikipedia_page(candidate)
        if payload:
            return payload
    return None


def _report_rate_limit_key(session_id: str) -> str:
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")
    return f"{ip}:{session_id}"


def _is_rate_limited(session_id: str) -> bool:
    now = time.time()
    key = _report_rate_limit_key(session_id)
    timestamps = [t for t in _report_rate_limiter[key] if now - t <= REPORT_RATE_LIMIT_WINDOW_SEC]
    limited = len(timestamps) >= REPORT_RATE_LIMIT_MAX
    if not limited:
        timestamps.append(now)
    _report_rate_limiter[key] = timestamps
    return limited


def _maps_link_for_place(place_guess: str | None) -> str | None:
    if not place_guess:
        return None
    cleaned = place_guess.strip()
    if not cleaned:
        return None
    return f"https://www.google.com/maps/search/?api=1&query={quote(cleaned, safe='')}"


def _is_rapid_duplicate_report(session_id: str, message_id: str, reason: str) -> bool:
    cutoff = datetime.fromtimestamp(time.time() - REPORT_DUPLICATE_WINDOW_SEC, tz=timezone.utc).isoformat()
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM incidents
            WHERE session_id = ? AND message_id = ? AND reason = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (session_id, message_id, reason, cutoff),
        ).fetchone()
    return row is not None


@app.get("/health")
def health() -> Any:
    return jsonify({"status": "ok", "service": "VisionGPT Flask"})


@app.post("/api/chat/analyze")
def analyze() -> Any:
    session_id = request.form.get("session_id", "")
    message = request.form.get("message", "Analyze this image")
    image = request.files.get("image")

    if not session_id:
        return jsonify({"error": "session_id is required"}), 400

    image_hash = None
    image_b64 = None
    mime_type = None

    if image:
        raw = image.read()
        size_mb = len(raw) / (1024 * 1024)
        if size_mb > MAX_UPLOAD_MB:
            return jsonify({"error": f"Image exceeds {MAX_UPLOAD_MB} MB"}), 400
        image_hash = hashlib.sha256(raw).hexdigest()
        image_b64 = base64.b64encode(raw).decode("utf-8")
        mime_type = image.mimetype or "image/jpeg"

    user_message_id = hashlib.sha1(f"{session_id}-{_now()}-user".encode()).hexdigest()
    _save_message(user_message_id, session_id, "user", message, image_hash)

    prompt = (
        "Return STRICT JSON only with keys: summary, risk_level, confidence, entities, location_name, possible_location, rationale, recommended_actions. "
        "risk_level must be low|medium|high|uncertain and confidence must be in [0,1]. "
        "location_name must be a short canonical place/entity name only (e.g., 'Shaniwar Wada'), or null if unknown. "
        "possible_location can include city/state/country context. "
        "Use cautious language. User query: "
        + message
    )

    structured = _gemini_structured(prompt, image_b64, mime_type) or _fallback(message)
    structured = _normalize_structured_output(structured, message)

    risk_level = str(structured["risk_level"]).lower()
    confidence = float(structured["confidence"])

    entities = structured.get("entities", [])
    if not isinstance(entities, list):
        entities = []
    entities = [str(x) for x in entities[:8]]

    place_guess = structured.get("possible_location")
    if place_guess is not None:
        place_guess = str(place_guess)
    location_name = structured.get("location_name")
    if location_name is not None:
        location_name = str(location_name)

    payload = {
        "reply": f"{structured.get('summary', 'Analysis complete.')}\n\nReasoning: {structured.get('rationale', 'Not available.')}",
        "risk_level": risk_level,
        "confidence": confidence,
        "entities": entities,
        "location_name": location_name,
        "place_guess": place_guess,
        "actions": _actions(risk_level, confidence, location_name, place_guess),
    }

    bot_message_id = hashlib.sha1(f"{session_id}-{_now()}-assistant".encode()).hexdigest()
    _save_message(bot_message_id, session_id, "assistant", json.dumps(payload))
    _save_model_output(bot_message_id, risk_level, confidence, structured)

    return jsonify(payload)


@app.get("/api/actions/learn-more")
def learn_more() -> Any:
    raw_query = request.args.get("query", "")
    query = _sanitize_wikipedia_query(raw_query)
    if not query:
        return jsonify({"error": "query is required"}), 400

    try:
        summary_payload = _fetch_wikipedia_summary(query)
        if summary_payload:
            _log_action("learn-more", "learn_more", {"query": query, "resolved_title": summary_payload["title"]})
            return jsonify(summary_payload)
    except Exception:
        pass

    _log_action("learn-more", "learn_more", {"query": query, "resolved_title": None})
    return jsonify(
        {
            "title": query,
            "summary": "No reliable Wikipedia summary was found for this query. Please review the search results.",
            "url": f"https://en.wikipedia.org/w/index.php?search={quote(query, safe='')}",
        }
    )


@app.post("/api/actions/report")
def report() -> Any:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return (
            jsonify(
                {
                    "status": "rejected",
                    "incident_id": None,
                    "whatsapp": {"sent": False, "reason": "invalid_json_body"},
                }
            ),
            400,
        )
    try:
        payload = ReportRequest.model_validate(body)
    except ValidationError as exc:
        return (
            jsonify(
                {
                    "status": "rejected",
                    "incident_id": None,
                    "whatsapp": {"sent": False, "reason": "validation_failed"},
                    "errors": exc.errors(),
                }
            ),
            400,
        )

    if not payload.confirm:
        return (
            jsonify(
                {
                    "status": "rejected",
                    "incident_id": None,
                    "whatsapp": {"sent": False, "reason": "confirmation_required"},
                }
            ),
            400,
        )

    if _is_rate_limited(payload.session_id):
        return (
            jsonify(
                {
                    "status": "blocked",
                    "incident_id": None,
                    "whatsapp": {"sent": False, "reason": "rate_limited"},
                }
            ),
            429,
        )

    if _is_rapid_duplicate_report(payload.session_id, payload.message_id, payload.reason):
        return (
            jsonify(
                {
                    "status": "duplicate",
                    "incident_id": None,
                    "whatsapp": {"sent": False, "reason": "duplicate_report"},
                }
            ),
            409,
        )

    with _conn() as conn:
        cursor = conn.execute(
            """
            INSERT INTO incidents (
              session_id, message_id, reason, confirmed_by_user,
              whatsapp_attempted, whatsapp_sent, whatsapp_reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (payload.session_id, payload.message_id, payload.reason, 1, 0, 0, "not_requested", _now()),
        )
        incident_id = cursor.lastrowid

    whatsapp_status = {"sent": False, "reason": "not_requested"}
    if payload.notify_whatsapp and ENABLE_WHATSAPP_NOTIFY:
        incident_summary = (payload.incident_summary or payload.reason).strip()
        place_guess = (payload.place_guess or "").strip() or None
        maps_link = _maps_link_for_place(place_guess)
        alert_message = (
            "VisionGPT incident report (human confirmation needed)\n"
            f"Possible incident: {incident_summary}\n"
            f"Location: {place_guess or 'Location not confidently identified'}\n"
            f"Maps: {maps_link or 'Not available'}\n"
            "This is a possible suspicious activity report and requires human verification.\n"
            f"Reported at: {_now()}"
        )
        whatsapp_status = _send_whatsapp_alert(alert_message)
    elif payload.notify_whatsapp and not ENABLE_WHATSAPP_NOTIFY:
        whatsapp_status = {"sent": False, "reason": "disabled_by_env"}

    whatsapp_attempted = int(payload.notify_whatsapp and ENABLE_WHATSAPP_NOTIFY)
    whatsapp_sent = int(bool(whatsapp_status.get("sent")))
    whatsapp_reason = str(whatsapp_status.get("reason", "unknown"))

    with _conn() as conn:
        conn.execute(
            "UPDATE incidents SET whatsapp_attempted = ?, whatsapp_sent = ?, whatsapp_reason = ? WHERE id = ?",
            (whatsapp_attempted, whatsapp_sent, whatsapp_reason, incident_id),
        )

    _log_action(
        payload.message_id,
        "report",
        {
            "incident_id": incident_id,
            "session_id": payload.session_id,
            "confirm": payload.confirm,
            "notify_whatsapp": payload.notify_whatsapp,
            "incident_summary": payload.incident_summary,
            "place_guess": payload.place_guess,
            "whatsapp": whatsapp_status,
        },
    )

    return jsonify(
        {
            "status": "logged",
            "incident_id": incident_id,
            "whatsapp": whatsapp_status,
        }
    )


@app.get("/api/incidents")
def list_incidents() -> Any:
    try:
        query = ListQuery.model_validate(
            {
                "limit": request.args.get("limit", 50),
                "offset": request.args.get("offset", 0),
            }
        )
    except ValidationError as exc:
        return jsonify({"error": "invalid_pagination", "details": exc.errors()}), 400

    session_id = request.args.get("session_id")
    with _conn() as conn:
        if session_id:
            rows = conn.execute(
                """
                SELECT id, session_id, message_id, reason, confirmed_by_user,
                       whatsapp_attempted, whatsapp_sent, whatsapp_reason, created_at
                FROM incidents
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (session_id, query.limit, query.offset),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, session_id, message_id, reason, confirmed_by_user,
                       whatsapp_attempted, whatsapp_sent, whatsapp_reason, created_at
                FROM incidents
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (query.limit, query.offset),
            ).fetchall()

    items = [
        {
            "id": row["id"],
            "session_id": row["session_id"],
            "message_id": row["message_id"],
            "reason": row["reason"],
            "confirmed_by_user": bool(row["confirmed_by_user"]),
            "whatsapp": {
                "attempted": bool(row["whatsapp_attempted"]),
                "sent": bool(row["whatsapp_sent"]),
                "reason": row["whatsapp_reason"],
            },
            "created_at": row["created_at"],
        }
        for row in rows
    ]
    return jsonify({"items": items, "count": len(items)})


@app.get("/api/sessions")
def list_sessions() -> Any:
    try:
        query = ListQuery.model_validate(
            {
                "limit": request.args.get("limit", 50),
                "offset": request.args.get("offset", 0),
            }
        )
    except ValidationError as exc:
        return jsonify({"error": "invalid_pagination", "details": exc.errors()}), 400

    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT s.id, s.created_at, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at
            FROM sessions s
            LEFT JOIN messages m ON s.id = m.session_id
            GROUP BY s.id, s.created_at
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (query.limit, query.offset),
        ).fetchall()

    items = [
        {
            "id": row["id"],
            "created_at": row["created_at"],
            "message_count": row["message_count"],
            "last_message_at": row["last_message_at"],
        }
        for row in rows
    ]
    return jsonify({"items": items, "count": len(items)})


@app.get("/api/sessions/<session_id>/messages")
def list_session_messages(session_id: str) -> Any:
    if not session_id:
        return jsonify({"error": "session_id is required"}), 400

    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT id, session_id, role, text, image_hash, created_at
            FROM messages
            WHERE session_id = ?
            ORDER BY created_at ASC
            """,
            (session_id,),
        ).fetchall()

    items = [
        {
            "id": row["id"],
            "session_id": row["session_id"],
            "role": row["role"],
            "text": row["text"],
            "image_hash": row["image_hash"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]
    return jsonify({"items": items, "count": len(items)})


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=True)
