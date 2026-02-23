# Product Requirements Document (PRD)

## 1. Product Name
VisionGPT

## 2. Problem Statement
Current project behavior is mostly image API orchestration and location lookup. It does not deliver a conversational decision-support workflow with explicit actions and auditable outcomes.

## 3. Product Vision
A chat-first multimodal bot where users upload images and receive:
- Interpretable scene explanation
- Risk-aware guidance when suspicious activity may be present
- Action buttons for follow-up (`Report`, `Learn More`, etc.)

## 4. Target Users
- Students/research evaluators (demo + methodology)
- Public safety observers (manual incident reporting flow)
- General users seeking context about places/images

## 5. Scope
### In Scope (MVP)
- Chat UI with image + text messages
- Vision inference using Gemini
- Structured JSON outputs (`summary`, `risk_level`, `confidence`, `actions`, `entities`)
- Action-button rendering beneath assistant replies
- `Learn More` action routed to Wikipedia
- `Report Suspicious Activity` action with confirmation and logging
- Optional WhatsApp authority notification via WHAPI after explicit user confirmation
- Session history and incident audit trail

### Out of Scope (MVP)
- Automatic alerting to real authorities without user confirmation
- Identity verification and legal reporting compliance
- Multi-tenant RBAC and enterprise auth
- SMS provider integration (future scope)

## 6. User Stories
1. As a user, I upload an image and get a clear explanation of what is happening.
2. As a user, when risky behavior is detected, I get a safe, explicit option to report it.
3. As a user, for normal place images, I can click `Learn More` and open a relevant knowledge source.
4. As a reviewer, I can inspect logs showing model output, confidence, and user action.

## 7. Functional Requirements
1. Accept image file uploads (`jpg`, `jpeg`, `png`, `webp`) up to configurable limit.
2. Send image + prompt to vision model and request strict JSON output.
3. Validate model JSON against schema. If invalid, run repair step or safe fallback response.
4. Compute final risk band using model score + policy thresholds.
5. Render button set based on risk policy:
- `high`: `Report Suspicious Activity`, `Safety Tips`, `Why this result?`
- `medium`: `Review Carefully`, `Safety Tips`, `Why this result?`
- `low`: `Learn More`, `Open Map`, `Why this result?`
6. On `Learn More`, fetch Wikipedia summary/page link for top place/entity.
7. On `Report Suspicious Activity`, require user confirmation, then log incident.
8. If enabled and user opts in, send WhatsApp notification to preconfigured authority number via WHAPI.
9. Persist conversation turns and actions.

## 8. Non-Functional Requirements
- P95 response latency target: <= 8 seconds (MVP)
- Uptime target for demo: >= 95%
- Fail-safe behavior: no-risk default if model confidence is low/invalid
- Basic privacy: store image hash, not raw image by default (configurable)

## 9. Safety and Policy Requirements
1. No automatic emergency dispatch.
2. Use neutral language: "possible suspicious activity" not definitive accusations.
3. Always provide uncertainty when confidence is low.
4. Require confirmation before incident logging.

## 10. Data Model (MVP)
- `sessions(id, created_at)`
- `messages(id, session_id, role, text, image_path, created_at)`
- `model_outputs(id, message_id, risk_level, confidence, json_payload, created_at)`
- `incidents(id, session_id, message_id, reason, confirmed_by_user, created_at)`
- `actions(id, message_id, action_type, payload, created_at)`

## 11. API Contracts (MVP)
### `POST /api/chat/analyze`
Input: multipart form (`session_id`, `message`, optional `image`)
Output:
```json
{
  "reply": "string",
  "risk_level": "low|medium|high|uncertain",
  "confidence": 0.0,
  "entities": ["string"],
  "place_guess": "string|null",
  "actions": [
    {"type": "report", "label": "Report Suspicious Activity", "payload": {}},
    {"type": "learn_more", "label": "Learn More", "payload": {"query": "Eiffel Tower"}}
  ]
}
```

### `POST /api/actions/report`
Input: `session_id`, `message_id`, `reason`, `confirm=true`, `notify_whatsapp=bool`
Output: `incident_id`, `status`, `whatsapp`

### `GET /api/actions/learn-more?query=...`
Output: `title`, `summary`, `url`

## 12. Success Metrics (for demo/report)
- Risk classification precision/recall on curated test set
- False alarm rate
- Structured-output validity rate
- Action click-through rate (`Learn More`, `Report`)
- End-to-end latency

## 13. Demo Acceptance Criteria
1. Uploading an image returns text + actionable buttons.
2. At least one risky sample triggers `Report Suspicious Activity`.
3. At least one place sample triggers `Learn More` and opens valid wiki result.
4. Incident log and conversation history are reviewable.
