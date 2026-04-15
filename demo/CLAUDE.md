# demo spike

Run from `demo/`, not project root. This directory has its own `node_modules` with `@anthropic-ai/sdk@0.89.0` (managed agents beta).

`.env` is symlinked from repo root. If missing: `ln -s ../.env .env`

Agent and environment IDs are in `server.ts` constants.

No build step. No pi-agent-core dependency. Bun HTTP server only.
