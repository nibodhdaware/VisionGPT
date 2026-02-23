# Weekend MVP Plan

## Objective
Ship a working end-to-end VisionGPT prototype in one weekend.

## Scope Lock
- Single primary model: Gemini Vision
- Optional Llama fallback can be stubbed
- SQLite only
- No auth for MVP
- Optional WHAPI WhatsApp escalation after explicit user confirmation

## Day 1 (Build Core)
1. Scaffold backend with `uv` and frontend with `npx` (Vite React TS).
2. Build chat UI with image uploader and message timeline.
3. Implement `/api/chat/analyze`.
4. Add Gemini request + strict JSON schema enforcement.
5. Render dynamic inline action buttons.

## Day 2 (Actions + Hardening)
1. Implement `Learn More` via Wikipedia endpoint.
2. Implement `Report Suspicious Activity` with confirm modal + incident logging.
3. Add optional `notify_whatsapp` path in report flow via WHAPI env config.
4. Add session persistence and message history.
5. Add fallback responses for invalid model output / timeout.
6. Prepare demo set (10-20 images) and metrics table.

## JSON Schema (expected from model)
```json
{
  "summary": "string",
  "risk_level": "low|medium|high|uncertain",
  "confidence": 0.0,
  "entities": ["string"],
  "possible_location": "string|null",
  "rationale": "string",
  "recommended_actions": ["report", "learn_more", "open_map", "safety_tips"]
}
```

## Risk Policy
- `high` and confidence >= 0.65: show `Report Suspicious Activity`
- `medium`: show caution actions, no hard claim
- `low`: show `Learn More`, `Open Map`
- `uncertain` or confidence < 0.45: show uncertainty notice + ask for more context

## Demo Dataset Guidance
- 5 normal place images
- 5 ambiguous/generic scenes
- 5 potentially suspicious scenes
- 2 edge cases (blurry, dark, occluded)

## Minimum Demo Script
1. Normal landmark image -> summary + `Learn More`
2. Potentially risky image -> safety-oriented response + `Report`
3. Ambiguous image -> uncertainty response with no hard accusation
4. Show incident log table

## Known Limits (to mention in viva)
- Model hallucination risk
- Bias and context dependence
- Not a legal/forensic authority tool
- Requires human verification before action
