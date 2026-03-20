# sincere

Bun-based AI agent project using `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Runtime

- Bun, not Node.js. Use `bun run`, `bun test`, `bun:sqlite`, `Bun.file`, etc.
- Bun auto-loads `.env` — no dotenv needed.

## Architectural Invariants

1. **Single LLM gateway.** All LLM calls go through a single `llm_task` tool. No other tool may wrap or invoke an LLM call. This keeps token spend observable and prompt logic centralised.

2. **Tools are typed functions, not classes.** Every tool is a plain function with metadata. Schemas are defined with TypeBox (from pi-ai). No class hierarchies, no `BaseTool`.

3. **Operator prompt is the single source of reasoning.** The file `src/operator.md` is the sole source of agent reasoning principles. Do not scatter system-prompt fragments across code files.

4. **Append-only JSONL for durable state.** All events and state transitions are appended to JSONL files. Never mutate or delete log lines. SQLite (`bun:sqlite`) is used alongside for queryable ticket/task data — treat it as a read-optimised projection, not the source of truth.

5. **Structured logging only.** Use `pino` everywhere. No `console.log`, `console.warn`, or `console.error`. Import the shared logger from `src/lib/logger.ts`.

## Project Layout

```
src/
  index.ts          # entry point
  operator.md       # agent system prompt (sole source of reasoning principles)
  lib/              # shared utilities (logger, etc.)
  tools/            # tool definitions (typed functions + TypeBox schemas)
  skills/           # higher-level skill compositions
```
