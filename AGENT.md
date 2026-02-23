# AGENT Configuration - VisionGPT MVP

## 1. Mission
Implement and iterate a chat-style multimodal bot for image understanding, risk triage, and knowledge actions.

## 2. Hard Constraints
1. Keep MVP scope locked to `PRD.md` and `MVP.md`.
2. Do not implement automatic external authority dispatch.
3. WhatsApp escalation must always be user-confirmed and env-gated.
4. Always include uncertainty when confidence is low.
5. Prefer deterministic structured outputs over free-form text.

## 3. Preferred Stack
- Frontend: React + Vite + TypeScript + Tailwind + shadcn/ui-style components
- Backend: Flask + Pydantic + SQLite
- Runtime tooling:
  - Frontend scaffolding via `npx`
  - Backend dependency/runtime management via `uv`
- Model provider:
  - Primary: Gemini Vision API
  - Secondary optional: Llama (Ollama) behind feature flag

## 4. Environment Variables
Create `.env` files from templates.

### Backend `.env`
- `APP_ENV=dev`
- `PORT=8000`
- `DATABASE_PATH=./data/visiongpt.db`
- `GEMINI_API_KEY=`
- `GEMINI_MODEL=gemini-2.5-flash`
- `MAX_UPLOAD_MB=10`
- `STORE_RAW_IMAGES=false`
- `ENABLE_WHATSAPP_NOTIFY=false`
- `WHAPI_BASE_URL=https://gate.whapi.cloud`
- `WHAPI_TOKEN=`
- `AUTHORITY_WHATSAPP_TO=`

### Frontend `.env`
- `VITE_API_BASE_URL=http://localhost:8000`

## 5. API Behavior Contract
### Analyze Endpoint
- Input: text + optional image
- Output must include:
  - `reply`, `risk_level`, `confidence`, `actions`
- Validate model JSON and sanitize fields before returning.

### Action Mapping
- `risk_level=high`: include `report`
- `risk_level=low`: include `learn_more`
- Any low confidence: include `ask_for_context`

## 6. Prompt Contract (Model)
Model must return strict JSON only:
- `summary`
- `risk_level`
- `confidence`
- `entities`
- `possible_location`
- `rationale`
- `recommended_actions`

If model returns non-JSON:
1. Attempt one repair pass.
2. If still invalid, return safe fallback:
- `risk_level=uncertain`
- `confidence=0.0`
- actions: `ask_for_context` (+ `learn_more` if place entity exists)

## 7. UI Contract
- Chat bubbles for user and assistant
- Image preview inside message bubble
- Inline action buttons beneath each assistant response
- Confirmation modal before creating incident report
- Secondary confirmation for optional WhatsApp escalation

## 8. Logging and Audit
- Log: request id, latency, risk level, confidence, selected actions
- Never log API keys
- If `STORE_RAW_IMAGES=false`, persist SHA256 hash only

## 9. Code Quality Rules
- Type everything (TypeScript + Pydantic)
- Keep modules small and testable
- Add unit tests for parser/policy/fallback logic
- Add one integration test for `/api/chat/analyze`

## 10. Definition of Done (MVP)
1. End-to-end flow works locally.
2. Buttons render correctly from policy output.
3. `Learn More` and `Report` actions succeed.
4. Incident logs are queryable.
5. Demo checklist in `MVP.md` passes.

## 11. Suggested Task Order
1. Scaffold with `npx` and `uv`
2. Implement analyze endpoint + schema
3. Build chat UI + action buttons
4. Add `learn-more` integration
5. Add report flow + logs
6. Add tests and demo dataset
