# VisionGPT

VisionGPT is a chat-style multimodal MVP for image understanding, risk-aware guidance, and knowledge actions.

## Stack
- Frontend: React + Vite + TypeScript + Tailwind + shadcn/ui-style components
- Backend: Flask (Python) managed with `uv`
- Model: Gemini Vision API (with safe fallback when unavailable)

## Quick Start
1. Start backend:
```bash
cd backend
cp .env.example .env
uv run python main.py
```

2. Start frontend:
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

3. Open `http://localhost:5173`.

## Core Docs
- `PRD.md`
- `MVP.md`
- `AGENT.md`

## Safety Note
`Report Suspicious Activity` logs incidents locally by default.
Optional WHAPI-based WhatsApp escalation is supported, but only after explicit user confirmation and env configuration.
