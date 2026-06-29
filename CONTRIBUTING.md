# Contributing to VisionGPT

## Getting Started

1. Fork the repo and clone your fork.
2. Follow the setup instructions in the root `README.md`.
3. Create a feature branch (`git checkout -b feat/my-change`).

## Development

- **Backend**: Python 3.12+ with Flask. Run with `uv run python main.py`. Validate with `uv run python -m py_compile main.py`.
- **Frontend**: React + Vite + TypeScript. Run with `npm run dev`. Build with `npm run build`.
- **Code style**: Follow existing patterns. Avoid adding comments. Use TypeScript strict mode for frontend.

## Pull Request Process

1. Keep PRs focused on a single concern.
2. Update docs if your change affects setup, config, or API behavior.
3. Verify no new warnings or errors on both backend and frontend.
4. The `AGENT.md` file is the execution contract for AI agents working on this repo. If your change requires agent workflow updates, update it.

## Reporting Issues

Use the provided GitHub issue templates (Bug Report / Feature Request).

## Questions

Open a GitHub Discussion or refer to `PRD.md` / `MVP.md` for scope.
