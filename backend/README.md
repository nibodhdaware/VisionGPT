# VisionGPT Backend

Flask + SQLite backend for VisionGPT.

## 1) Setup and Run
```bash
cd backend
cp .env.example .env
uv sync
uv run python main.py
```

Backend runs on `http://localhost:8000` by default.

## 2) Environment Variables
Required:
- `DATABASE_PATH=./data/visiongpt.db`
- `MAX_UPLOAD_MB=10`

Gemini:
- `GEMINI_API_KEY=...`
- `GEMINI_MODEL=gemini-2.5-flash`

Optional WhatsApp escalation via WHAPI:
- `ENABLE_WHATSAPP_NOTIFY=false` (set `true` to allow send attempts)
- `WHAPI_BASE_URL=https://gate.whapi.cloud`
- `WHAPI_TOKEN=...`
- `AUTHORITY_WHATSAPP_TO=...`

Optional report safeguards:
- `REPORT_RATE_LIMIT_WINDOW_SEC=60`
- `REPORT_RATE_LIMIT_MAX=5`
- `REPORT_DUPLICATE_WINDOW_SEC=300`

Optional learn-more query bounds:
- `LEARN_MORE_MIN_QUERY_LEN=2`
- `LEARN_MORE_MAX_QUERY_LEN=120`

## 3) API Endpoints
- `GET /health`
- `POST /api/chat/analyze`
- `GET /api/actions/learn-more?query=...`
- `POST /api/actions/report`
- `GET /api/incidents`
- `GET /api/sessions`
- `GET /api/sessions/<id>/messages`

`Learn More` resolves topics using the Python `wikipedia` library (with disambiguation/search fallback) and returns `title`, `summary`, and `url`.

## 4) Report Endpoint Notes
`POST /api/actions/report` now enforces:
- strict request validation (`session_id`, `message_id`, `reason`, `confirm`, `notify_whatsapp`)
- anti-spam rate limiting
- duplicate report prevention
- structured response:
  - `status`
  - `incident_id`
  - `whatsapp.sent`
  - `whatsapp.reason`

WhatsApp send is attempted only if all are true:
- `confirm = true`
- `notify_whatsapp = true`
- `ENABLE_WHATSAPP_NOTIFY = true`

## 5) Quick Test Commands
Health:
```bash
curl -s http://localhost:8000/health
```

Learn more:
```bash
curl -s "http://localhost:8000/api/actions/learn-more?query=Eiffel%20Tower"
```

Report (without WhatsApp):
```bash
curl -s -X POST http://localhost:8000/api/actions/report \
  -H "Content-Type: application/json" \
  -d '{
    "session_id":"demo-session-1",
    "message_id":"demo-message-1",
    "reason":"Possible suspicious activity observed by user",
    "confirm":true,
    "notify_whatsapp":false
  }'
```

Read APIs:
```bash
curl -s "http://localhost:8000/api/incidents?limit=20&offset=0"
curl -s "http://localhost:8000/api/sessions?limit=20&offset=0"
curl -s "http://localhost:8000/api/sessions/demo-session-1/messages"
```

## 6) Local Syntax Check
```bash
cd backend
uv run python -m py_compile main.py
```
