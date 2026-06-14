from __future__ import annotations

import base64
import ast
import hashlib
import json
import math
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
from google import genai
from google.genai import types
from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS
from flask import Flask, jsonify, request
import flask
from flask_cors import CORS
from pydantic import BaseModel, ConfigDict, ValidationError, conint, constr
from wikipedia.exceptions import DisambiguationError, PageError, WikipediaException

load_dotenv()

app = Flask(__name__)
CORS(app)

DB_PATH = os.getenv("DATABASE_PATH", "./data/visiongpt.db")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEOCODING_API_KEY = os.getenv("GEOCODING_API_KEY", "")
VERTEX_AI = os.getenv("VERTEX_AI", "false").lower() in ("true", "1")
if VERTEX_AI:
    _gemini_client = genai.Client(
        vertexai=True,
        project=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
    )
elif GEMINI_API_KEY:
    _gemini_client = genai.Client(api_key=GEMINI_API_KEY, http_options=types.HttpOptions(api_version="v1"))
else:
    _gemini_client = None
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
DATASET_IMAGES_DIR = os.getenv("DATASET_IMAGES_DIR", "./data/dataset_images")

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

            CREATE TABLE IF NOT EXISTS locations (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              latitude REAL NOT NULL,
              longitude REAL NOT NULL,
              collection_frequency TEXT NOT NULL DEFAULT 'weekly',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dataset_images (
              id TEXT PRIMARY KEY,
              location_id TEXT NOT NULL,
              image_path TEXT NOT NULL,
              street_view_url TEXT,
              latitude REAL NOT NULL,
              longitude REAL NOT NULL,
              collected_at TEXT NOT NULL,
              analyzed_at TEXT,
              gemini_response TEXT,
              error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_dataset_images_location ON dataset_images(location_id, collected_at);
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

    def _parse_candidate(candidate: str) -> dict[str, Any] | None:
        cleaned = candidate.strip()
        if not cleaned:
            return None

        # Remove a leading language marker if the model emits "json\n{...}".
        cleaned = re.sub(r"^\s*json\s*", "", cleaned, flags=re.IGNORECASE).strip()
        # Tolerate trailing commas in objects/arrays.
        cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
        # Normalize smart quotes commonly returned by LLMs.
        cleaned = cleaned.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")

        try:
            parsed = json.loads(cleaned)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass

        # Fallback for Python-literal-like outputs: {'k': 'v', 'x': None}
        try:
            parsed = ast.literal_eval(cleaned)
            return parsed if isinstance(parsed, dict) else None
        except (SyntaxError, ValueError):
            return None

    # 1) Direct parse for pure JSON responses.
    direct = _parse_candidate(text)
    if direct:
        return direct

    # 2) Parse fenced blocks such as ```json ... ```.
    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE):
        parsed = _parse_candidate(match.group(1))
        if parsed:
            return parsed

    # 3) Scan the full text for the first valid JSON object.
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[idx:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    return None


def _gemini_generate(parts: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    if not _gemini_client:
        return None, "gemini_api_key_missing"
    try:
        content_parts: list[types.Part] = []
        for p in parts:
            if "inline_data" in p:
                content_parts.append(types.Part(inline_data=types.Blob(mime_type=p["inline_data"]["mime_type"], data=p["inline_data"]["data"])))
            else:
                content_parts.append(types.Part(text=p.get("text", "")))
        contents = [types.Content(parts=content_parts, role="user")]
        config = types.GenerateContentConfig(
            temperature=0.15,
            max_output_tokens=4096,
            response_mime_type="application/json",
        )
        response = _gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=config,
        )
        if not response.candidates:
            app.logger.warning("Gemini response had no candidates")
            return None, "gemini_no_candidates"
        text = response.text
        if not text:
            app.logger.warning("Gemini response candidate had no text")
            return None, "gemini_candidate_no_text"
        return text.strip(), None
    except Exception as exc:
        err_msg = str(exc).strip()[:300]
        app.logger.warning("Gemini generateContent failed: %s", err_msg)
        return None, f"gemini_error: {err_msg}"


def _repair_json_once(raw_text: str) -> tuple[dict[str, Any] | None, str | None]:
    if not raw_text:
        return None, "repair_input_empty"
    repair_prompt = (
        "Convert the following content into valid JSON only. "
        "Do not add explanation. Preserve intent and keys.\n\n"
        + raw_text
    )
    repaired_text, repair_error = _gemini_generate([{"text": repair_prompt}])
    if not repaired_text:
        return None, repair_error or "repair_generation_failed"
    repaired = _extract_json(repaired_text)
    if repaired:
        return repaired, None
    return None, "repair_parse_failed"


def _gemini_structured(prompt: str, image_b64: str | None, mime_type: str | None) -> tuple[dict[str, Any] | None, str | None]:
    if not _gemini_client:
        return None, "gemini_client_unavailable"

    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image_b64 and mime_type:
        parts.append({"inline_data": {"mime_type": mime_type, "data": image_b64}})

    try:
        text, generation_error = _gemini_generate(parts)
        if not text:
            return None, generation_error or "generation_failed"
        parsed = _extract_json(text or "")
        if parsed:
            return parsed, None
        repaired, repair_error = _repair_json_once(text or "")
        if repaired:
            return repaired, None
        return None, repair_error or "parse_failed"
    except Exception as exc:
        return None, f"gemini_exception: {exc.__class__.__name__}"


def _fallback(message: str, reason: str | None = None) -> dict[str, Any]:
    risk = "medium" if any(k in message.lower() for k in ["fight", "weapon", "blood"]) else "uncertain"
    confidence = 0.5 if risk == "medium" else 0.0
    return {
        "summary": "Model output was unavailable or invalid. This is a cautious fallback.",
        "risk_level": risk,
        "confidence": confidence,
        "entities": [],
        "location_name": None,
        "possible_location": None,
        "rationale": f"Fallback due to unavailable structured response ({reason})." if reason else "Fallback due to unavailable structured response.",
        "recommended_actions": [],
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
    return jsonify({"status": "ok", "service": "Image Geolocation API"})


def _dms_to_decimal(dms: tuple, ref: str) -> float | None:
    try:
        degrees, minutes, seconds = float(dms[0]), float(dms[1]), float(dms[2])
        decimal = degrees + minutes / 60.0 + seconds / 3600.0
        if ref in ("S", "W"):
            decimal = -decimal
        return decimal
    except (TypeError, ValueError, IndexError):
        return None


def _extract_exif(image_bytes: bytes) -> dict[str, Any]:
    import io
    result: dict[str, Any] = {"gps": None, "datetime": None, "camera": None, "all_tags": {}}
    try:
        img = Image.open(io.BytesIO(image_bytes))
        exif_data = img.getexif()
        if not exif_data:
            return result

        gps_info = {}
        for tag_id, value in exif_data.items():
            tag_name = TAGS.get(tag_id, str(tag_id))
            result["all_tags"][tag_name] = str(value)[:200]
            if tag_name == "GPSInfo":
                for gps_tag_id, gps_value in dict(value).items():
                    gps_tag_name = GPSTAGS.get(gps_tag_id, str(gps_tag_id))
                    gps_info[gps_tag_name] = gps_value

        if gps_info:
            lat = _dms_to_decimal(gps_info.get("GPSLatitude"), gps_info.get("GPSLatitudeRef"))
            lng = _dms_to_decimal(gps_info.get("GPSLongitude"), gps_info.get("GPSLongitudeRef"))
            if lat is not None and lng is not None:
                result["gps"] = {"latitude": lat, "longitude": lng}

        date_tag = result["all_tags"].get("DateTimeOriginal") or result["all_tags"].get("DateTime")
        if date_tag:
            result["datetime"] = date_tag

        model = result["all_tags"].get("Model")
        make = result["all_tags"].get("Make")
        if model or make:
            result["camera"] = f"{make or ''} {model or ''}".strip()
    except Exception:
        pass
    return result


def _extract_address_components(api_result: dict[str, Any]) -> dict[str, str | None]:
    components = (api_result.get("results") or [{}])[0].get("address_components", [])
    extracted: dict[str, str | None] = {"country": None, "state": None, "district": None, "area": None}
    for comp in components:
        types = comp.get("types", [])
        if "country" in types:
            extracted["country"] = comp.get("long_name")
        elif "administrative_area_level_1" in types:
            extracted["state"] = comp.get("long_name")
        elif "administrative_area_level_2" in types:
            extracted["district"] = comp.get("long_name")
        elif "sublocality" in types or "sublocality_level_1" in types or "neighborhood" in types:
            if not extracted["area"]:
                extracted["area"] = comp.get("long_name")
        elif "locality" in types and not extracted["area"]:
            extracted["area"] = comp.get("long_name")
    return extracted


def _reverse_geocode(lat: float, lng: float) -> dict[str, Any] | None:
    if not GEOCODING_API_KEY:
        return None
    try:
        resp = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"latlng": f"{lat},{lng}", "key": GEOCODING_API_KEY},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("status") != "OK" or not data.get("results"):
            return None
        result = data["results"][0]
        loc = result.get("geometry", {}).get("location", {})
        return {
            "latitude": loc.get("lat"),
            "longitude": loc.get("lng"),
            "formatted_address": result.get("formatted_address", ""),
            "place_id": result.get("place_id", ""),
            "address_components": _extract_address_components(data),
        }
    except Exception:
        return None


def _geocode_location(query: str) -> dict[str, Any] | None:
    if not GEOCODING_API_KEY or not query:
        return None
    try:
        resp = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"address": query, "key": GEOCODING_API_KEY},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("status") != "OK" or not data.get("results"):
            return None
        result = data["results"][0]
        loc = result.get("geometry", {}).get("location", {})
        return {
            "latitude": loc.get("lat"),
            "longitude": loc.get("lng"),
            "formatted_address": result.get("formatted_address", ""),
            "place_id": result.get("place_id", ""),
            "address_components": _extract_address_components(data),
        }
    except Exception:
        return None


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
        exif_data = _extract_exif(raw)
    else:
        exif_data = {"gps": None, "datetime": None, "camera": None, "all_tags": {}}

    user_message_id = hashlib.sha1(f"{session_id}-{_now()}-user".encode()).hexdigest()
    _save_message(user_message_id, session_id, "user", message, image_hash)

    exif_context = ""
    if exif_data["datetime"]:
        exif_context += f"Photo timestamp: {exif_data['datetime']}. "
    if exif_data["camera"]:
        exif_context += f"Camera: {exif_data['camera']}. "

    prompt = (
        "You are a geolocation expert. Your task is to identify the exact city and region where this photo was taken. "
        "Think step by step but be decisive. Never answer 'uncertain' unless the image has zero useful clues. "
        "Even for generic urban scenes, you MUST identify the city based on architecture style, "
        "infrastructure patterns, vegetation, vehicles, and any subtle clues.\n\n"
        f"{exif_context}"
        "Return one STRICT JSON object only (no markdown, no backticks, no extra text). "
        'Schema: {"summary": string, "risk_level": "low|medium|high|uncertain", "confidence": number_0_to_1, '
        '"entities": string[], "location_name": string|null, "possible_location": string|null, '
        '"rationale": string, "recommended_actions": string[]}.\n\n'
        "ANALYSIS STEPS (be thorough):\n"
        "1. TEXT — Read every sign, billboard, storefront, vehicle marking, or license plate. "
        "Language, script, and specific names are the strongest clues.\n"
        "2. LANDMARKS — Identify any famous monument, temple, mosque, church, fort, statue, bridge, or building. "
        "Be specific: say 'Shaniwar Wada fort, Pune' not just 'a fort'.\n"
        "3. ARCHITECTURE — Note architectural style, construction materials, colors, roof types, window styles. "
        "Indian cities have distinctive architecture patterns (e.g. Pune has specific balcony styles, "
        "Mumbai has Art Deco, etc.).\n"
        "4. NATURE — Vegetation, trees, plants, terrain. What climate or region do they indicate? "
        "Gulmohar/rain trees are common in Western India. Coconut/palm trees indicate coastal areas.\n"
        "5. VEHICLES — Car models, license plate colors/format, side of road driving, auto rickshaws, buses. "
        "Auto rickshaw colors often indicate city (green in Pune, black/yellow in Mumbai).\n"
        "6. PEOPLE — Clothing styles, uniforms, headwear. Are they local or tourist?\n"
        "7. INFRASTRUCTURE — Road quality, streetlights, power lines, paving materials.\n"
        "8. SYMBOLS — Flags, government markings, religious symbols, political signs.\n\n"
        "CRITICAL RULES:\n"
        "- possible_location MUST include at minimum the city and country. Format: 'City, State, Country'. "
        "E.g. 'Pune, Maharashtra, India'. Even if unsure, make your best guess.\n"
        "- If you can identify the city from architecture/vegetation/climate, state it confidently.\n"
        "- NEVER output just a country name as possible_location.\n"
        "- E.g. a photo with Gulmohar trees, high-rise construction, and tropical vegetation should say "
        "'Pune, Maharashtra, India' or 'Mumbai, Maharashtra, India' or similar, not just 'India'.\n"
        "- location_name: Specific landmark name visible, or null if none.\n\n"
        "Explain which clues led to your conclusion in the rationale field.\n"
        "User query: "
        + message
    )

    structured_data, model_error = _gemini_structured(prompt, image_b64, mime_type)
    structured = structured_data or _fallback(message, model_error)
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

    geocoded = None
    if exif_data["gps"]:
        geocoded = _reverse_geocode(exif_data["gps"]["latitude"], exif_data["gps"]["longitude"])
    if not geocoded and (location_name or place_guess):
        geocoded = _geocode_location(location_name or place_guess)

    address_components = geocoded.get("address_components", {}) if geocoded else {}
    payload = {
        "reply": f"{structured.get('summary', 'Analysis complete.')}\n\nReasoning: {structured.get('rationale', 'Not available.')}",
        "risk_level": risk_level,
        "confidence": confidence,
        "entities": entities,
        "location_name": location_name,
        "place_guess": place_guess,
        "latitude": geocoded["latitude"] if geocoded else None,
        "longitude": geocoded["longitude"] if geocoded else None,
        "formatted_address": geocoded["formatted_address"] if geocoded else None,
        "country": address_components.get("country"),
        "state": address_components.get("state"),
        "district": address_components.get("district"),
        "area": address_components.get("area"),
        "exif_timestamp": exif_data.get("datetime"),
        "exif_camera": exif_data.get("camera"),
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
            "Image Geolocation incident report (human confirmation needed)\n"
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


# ── Dataset / Street View ──────────────────────────────────────────────

def _fetch_street_view(lat: float, lng: float, image_id: str) -> tuple[str | None, str | None]:
    if not GEOCODING_API_KEY:
        return None, "geocoding_api_key_missing"
    os.makedirs(DATASET_IMAGES_DIR, exist_ok=True)
    ext = "jpg"
    filename = f"{image_id}.{ext}"
    path = os.path.join(DATASET_IMAGES_DIR, filename)
    url = (
        "https://maps.googleapis.com/maps/api/streetview"
        f"?size=640x480&location={lat},{lng}"
        f"&key={GEOCODING_API_KEY}&source=outdoor&return_error_code=true"
    )
    try:
        resp = requests.get(url, timeout=20)
        if resp.status_code == 404:
            return None, "no_street_view_imagery"
        if resp.status_code != 200:
            body = resp.text[:200]
            return None, f"streetview_http_{resp.status_code}: {body}"
        if len(resp.content) < 1000:
            return None, "streetview_no_image"
        with open(path, "wb") as f:
            f.write(resp.content)
        return path, None
    except Exception as exc:
        return None, f"streetview_error: {exc}"


def _analyze_street_view_image(image_path: str) -> dict[str, Any]:
    if not os.path.exists(image_path):
        return {"error": "image_not_found"}
    with open(image_path, "rb") as f:
        raw = f.read()
    image_b64 = base64.b64encode(raw).decode("utf-8")
    mime_type = "image/jpeg"

    prompt = (
        "You are a geolocation expert. Identify where this Google Street View photo was taken "
        "based on visual clues. Be as specific as possible — at minimum identify the city and country. "
        "Return JSON only: "
        '{"summary": string, "location_name": string|null, "possible_location": string, '
        '"confidence": number_0_to_1, "entities": string[], "rationale": string}'
    )
    structured_data, model_error = _gemini_structured(prompt, image_b64, mime_type)
    result: dict[str, Any] = {"model_error": model_error}

    if structured_data:
        result["summary"] = str(structured_data.get("summary", ""))
        result["location_name"] = str(structured_data["location_name"]) if structured_data.get("location_name") else None
        result["possible_location"] = str(structured_data.get("possible_location", ""))
        result["confidence"] = float(structured_data.get("confidence", 0))
        result["entities"] = [str(e) for e in (structured_data.get("entities") or [])[:8]]

        place_guess = result["possible_location"] or result["location_name"]
        geocoded = _geocode_location(place_guess) if place_guess else None
        if geocoded:
            result["latitude"] = geocoded.get("latitude")
            result["longitude"] = geocoded.get("longitude")
            result["formatted_address"] = geocoded.get("formatted_address", "")
            ac = geocoded.get("address_components", {})
            result["country"] = ac.get("country")
            result["state"] = ac.get("state")
            result["district"] = ac.get("district")
            result["area"] = ac.get("area")
    return result


# ── Dataset helpers ─────────────────────────────────────────────────

def _check_street_view_coverage(lat: float, lng: float) -> bool:
    if not GEOCODING_API_KEY:
        return False
    try:
        resp = requests.get(
            "https://maps.googleapis.com/maps/api/streetview/metadata"
            f"?location={lat},{lng}&key={GEOCODING_API_KEY}",
            timeout=10,
        )
        if resp.status_code != 200:
            return False
        data = resp.json()
        return data.get("status") == "OK"
    except Exception:
        return False


def _generate_spiral_points(
    center_lat: float, center_lng: float,
    step_meters: float, max_radius_km: float, max_points: int,
) -> list[tuple[float, float]]:
    """Fermat spiral — uniform coverage expanding outward."""
    points: list[tuple[float, float]] = []
    lat_deg = step_meters / 111_320.0
    max_r_deg = max_radius_km / 111.32
    theta = 0.0
    for i in range(max_points):
        r = lat_deg * math.sqrt(i + 1)
        if r > max_r_deg:
            break
        theta += math.pi * 0.618033988749895  # golden angle
        dx = r * math.cos(theta)
        dy = r * math.sin(theta)
        plng = center_lng + dx / max(math.cos(math.radians(center_lat)), 0.01)
        plat = center_lat + dy
        points.append((plat, plng))
    return points


# ── Dataset API endpoints ──────────────────────────────────────────

class LocationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: constr(min_length=1, max_length=200)
    latitude: float
    longitude: float
    collection_frequency: constr(pattern=r"^(daily|weekly|monthly)$") = "weekly"


@app.post("/api/dataset/locations")
def create_location() -> Any:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_json"}), 400
    try:
        payload = LocationCreate.model_validate(body)
    except ValidationError as exc:
        return jsonify({"error": "validation_failed", "details": exc.errors()}), 400

    loc_id = hashlib.sha1(f"{payload.name}-{_now()}".encode()).hexdigest()[:16]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO locations (id, name, latitude, longitude, collection_frequency, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (loc_id, payload.name, payload.latitude, payload.longitude, payload.collection_frequency, _now()),
        )
    return jsonify({"id": loc_id, "status": "created"}), 201


@app.get("/api/dataset/locations")
def list_locations() -> Any:
    rows = _conn().execute(
        "SELECT id, name, latitude, longitude, collection_frequency, created_at FROM locations ORDER BY created_at DESC"
    ).fetchall()
    return jsonify({
        "items": [
            {
                "id": r["id"], "name": r["name"],
                "latitude": r["latitude"], "longitude": r["longitude"],
                "collection_frequency": r["collection_frequency"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    })


@app.delete("/api/dataset/locations/<location_id>")
def delete_location(location_id: str) -> Any:
    if not location_id:
        return jsonify({"error": "location_id required"}), 400
    with _conn() as conn:
        conn.execute("DELETE FROM dataset_images WHERE location_id = ?", (location_id,))
        conn.execute("DELETE FROM locations WHERE id = ?", (location_id,))
    return jsonify({"status": "deleted"})


@app.post("/api/dataset/locations/<location_id>/collect")
def collect_location_image(location_id: str) -> Any:
    row = _conn().execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone()
    if not row:
        return jsonify({"error": "location_not_found"}), 404

    image_id = hashlib.sha1(f"{row['id']}-{_now()}".encode()).hexdigest()[:16]
    image_path, fetch_error = _fetch_street_view(row["latitude"], row["longitude"], image_id)
    if fetch_error:
        with _conn() as conn:
            conn.execute(
                "INSERT INTO dataset_images (id, location_id, image_path, street_view_url, latitude, longitude, collected_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (image_id, location_id, "", f"https://maps.googleapis.com/maps/api/streetview?size=640x480&location={row['latitude']},{row['longitude']}", row["latitude"], row["longitude"], _now(), fetch_error),
            )
        return jsonify({"status": "error", "error": fetch_error}), 500

    # Analyze
    analysis = _analyze_street_view_image(image_path)
    gemini_json = json.dumps(analysis)

    with _conn() as conn:
        conn.execute(
            "INSERT INTO dataset_images (id, location_id, image_path, street_view_url, latitude, longitude, collected_at, analyzed_at, gemini_response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (image_id, location_id, image_path, f"https://maps.googleapis.com/maps/api/streetview?size=640x480&location={row['latitude']},{row['longitude']}", row["latitude"], row["longitude"], _now(), _now(), gemini_json, None),
        )
    return jsonify({"status": "collected", "image_id": image_id, "analysis": analysis})


@app.get("/api/dataset/locations/<location_id>/images")
def list_location_images(location_id: str) -> Any:
    rows = _conn().execute(
        "SELECT id, location_id, image_path, street_view_url, latitude, longitude, collected_at, analyzed_at, gemini_response, error FROM dataset_images WHERE location_id = ? ORDER BY collected_at DESC",
        (location_id,),
    ).fetchall()
    return jsonify({
        "items": [
            {
                "id": r["id"],
                "location_id": r["location_id"],
                "image_url": f"/api/dataset/images/{r['id']}/file" if r["image_path"] else None,
                "street_view_url": r["street_view_url"],
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "collected_at": r["collected_at"],
                "analyzed_at": r["analyzed_at"],
                "analysis": json.loads(r["gemini_response"]) if r["gemini_response"] else None,
                "error": r["error"],
            }
            for r in rows
        ]
    })


@app.get("/api/dataset/images")
def list_all_dataset_images() -> Any:
    rows = _conn().execute(
        """SELECT di.id, di.location_id, di.image_path, di.street_view_url,
                  di.latitude, di.longitude, di.collected_at, di.analyzed_at,
                  di.gemini_response, di.error,
                  l.name AS location_name
           FROM dataset_images di
           LEFT JOIN locations l ON di.location_id = l.id
           ORDER BY di.collected_at DESC"""
    ).fetchall()
    return jsonify({
        "items": [
            {
                "id": r["id"],
                "location_id": r["location_id"],
                "location_name": r["location_name"],
                "image_url": f"/api/dataset/images/{r['id']}/file" if r["image_path"] else None,
                "street_view_url": r["street_view_url"],
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "collected_at": r["collected_at"],
                "analyzed_at": r["analyzed_at"],
                "analysis": json.loads(r["gemini_response"]) if r["gemini_response"] else None,
                "error": r["error"],
            }
            for r in rows
        ]
    })


@app.get("/api/dataset/images/<image_id>/file")
def serve_dataset_image(image_id: str) -> Any:
    row = _conn().execute("SELECT image_path FROM dataset_images WHERE id = ?", (image_id,)).fetchone()
    if not row or not row["image_path"] or not os.path.exists(row["image_path"]):
        return jsonify({"error": "image_not_found"}), 404
    return flask.send_file(row["image_path"], mimetype="image/jpeg")


@app.post("/api/dataset/auto-collect")
def auto_collect() -> Any:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_json"}), 400
    lat = body.get("latitude")
    lng = body.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return jsonify({"error": "latitude and longitude required"}), 400
    max_locations = int(body.get("max_locations", 20))
    step_meters = float(body.get("step_meters", 50))
    max_radius_km = float(body.get("max_radius_km", 5))
    max_locations = min(max_locations, 100)
    max_radius_km = min(max_radius_km, 50.0)

    candidates = _generate_spiral_points(lat, lng, step_meters, max_radius_km, max_locations * 10)
    created: list[dict[str, Any]] = []
    total_checked = 0

    for clat, clng in candidates:
        if len(created) >= max_locations:
            break
        total_checked += 1

        # Skip if too close to an existing location
        existing = _conn().execute(
            "SELECT id FROM locations WHERE ABS(latitude - ?) < 0.0005 AND ABS(longitude - ?) < 0.0005",
            (clat, clng),
        ).fetchone()
        if existing:
            continue

        if not _check_street_view_coverage(clat, clng):
            continue

        loc_id = hashlib.sha1(f"auto-{clat}-{clng}-{_now()}".encode()).hexdigest()[:16]
        loc_name = f"Auto {len(created) + 1} ({clat:.4f}, {clng:.4f})"
        with _conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO locations (id, name, latitude, longitude, collection_frequency, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (loc_id, loc_name, clat, clng, "weekly", _now()),
            )

        # Collect image immediately
        image_id = hashlib.sha1(f"{loc_id}-{_now()}".encode()).hexdigest()[:16]
        image_path, fetch_error = _fetch_street_view(clat, clng, image_id)
        if fetch_error:
            with _conn() as conn:
                conn.execute(
                    "INSERT INTO dataset_images (id, location_id, image_path, street_view_url, latitude, longitude, collected_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (image_id, loc_id, "", f"https://maps.googleapis.com/maps/api/streetview?size=640x480&location={clat},{clng}", clat, clng, _now(), fetch_error),
                )
            if fetch_error != "no_street_view_imagery":
                created.append({"id": loc_id, "name": loc_name, "latitude": clat, "longitude": clng, "image_id": image_id, "error": fetch_error})
            continue

        analysis = _analyze_street_view_image(image_path)
        gemini_json = json.dumps(analysis)
        with _conn() as conn:
            conn.execute(
                "INSERT INTO dataset_images (id, location_id, image_path, street_view_url, latitude, longitude, collected_at, analyzed_at, gemini_response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (image_id, loc_id, image_path, f"https://maps.googleapis.com/maps/api/streetview?size=640x480&location={clat},{clng}", clat, clng, _now(), _now(), gemini_json, None),
            )
        created.append({"id": loc_id, "name": loc_name, "latitude": clat, "longitude": clng, "image_id": image_id, "error": None})

    return jsonify({"items": created, "total_checked": total_checked, "found": len(created)})


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=True)
