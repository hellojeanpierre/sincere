# sincere

Bun-based AI agent project using `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## demo spike

Run from `demo/`, not project root. This directory has its own `node_modules` with `@anthropic-ai/sdk@0.89.0` (managed agents beta).

`.env` is symlinked from repo root. If missing: `ln -s ../.env .env`

Agent and environment IDs are in `server.ts` constants.

No build step. No pi-agent-core dependency. Bun HTTP server only.

## Runtime

- Bun, not Node.js. Use `bun run`, `bun test`, `bun:sqlite`, `Bun.file`, etc.
- Bun auto-loads `.env` from the working directory (project root). All scripts run from root. Do not add manual `.env` loaders — `process.env` already has everything.

## Architectural Invariants

1. **Tools are dumb pipes.** A tool takes input, executes, returns output. No reasoning, no analytics logic, no parsing of results, no opinions about what the Analyst should do next. All intelligence lives in the Analyst's generated input, not in the tool.

2. **One tool, one branching point.** If the Analyst makes a meaningfully different decision when choosing between two operations, those are separate tools. Never hide mode-switching inside a parameter.

3. **Skills are context, not code.** A skill is a markdown file the Analyst reads before acting. It contains failure modes, heuristics, and domain knowledge that shape the Analyst's reasoning. Skills do not execute anything.

4. **Agent prompts are the single source of reasoning.** Each agent role (`src/observer.md`, `src/analyst.md`) is the sole source of reasoning principles for that role. Do not scatter system-prompt fragments across code files.

5. **Tools are typed functions, not classes.** Every tool is a plain function with metadata. Schemas are defined with TypeBox (from pi-ai). No class hierarchies, no `BaseTool`.

6. **Structured logging only.** Use `pino` everywhere. No `console.log`, `console.warn`, or `console.error`. Import the shared logger from `src/lib/logger.ts`. Exception: `process.stderr.write()` is allowed for streaming text deltas to the terminal.

7. **Agent config via `initialState`.** Configure the Agent's system prompt, model, and tools through `initialState` in the constructor. This keeps setup declarative and in one place.

8. **Skills, analyst.md, and tool description text are pattern-matching attractors.** Anything the Analyst reads shapes reasoning. Encode goals and transition signals, not numbered procedures. Always include exit conditions. Shorter text drifts goals less.

9. **Evals test agent behavior, unit tests test infra.** Never assert on model output in a unit test.

## Code Smells

- **Single-caller wrapper functions.** If a function has one call site and the body is shorter than a readable inline block, it is indirection without value. Inline it. Do not create a file, an export, and a test suite for something that is five lines at the point of use.

## Tool Surface

- **read** — returns file content as text. Unconditionally safe. Used for data files, knowledge graph triples, skill context, configuration.
- **bash** — runs a shell command in a subprocess, returns stdout/stderr. Allowlisted binaries only. Used for computation the Analyst cannot do in-context.

## Architecture

Two agent roles: **Analyst** discovers root causes from data; **Observer** matches work items against known failure patterns. Each has its own prompt (`src/analyst.md`, `src/observer.md`), tool set, and output contract. They do not share reasoning.

Tool results larger than 10 KB are compacted after 4 assistant turns — persisted to disk with a 2 KB preview kept inline. This is microcompaction (`makeTransformContext` in `agent.ts`).

## Project Layout

```
src/
  index.ts          # entry point
  agent.ts          # agent factory, microcompaction, session handler
  intake.ts         # Zendesk event → agent prompt
  gateway.ts        # HTTP server for webhooks
  lane.ts           # per-workitem serial queue
  analyst.md        # Analyst system prompt
  observer.md       # Observer system prompt
  config.json       # template variables for prompts
  graph.json        # root cause library (injected as {{rootCauses}})
  lib/
    logger.ts       # pino logger
    config.ts       # config loader + {{key}} template resolver
    trace.ts        # markdown trace writer (SSE-compatible)
  tools/            # typed functions + TypeBox schemas
  skills/           # markdown files read by agents for domain context
evals/              # eval harnesses (closure, skill-routing)
demo/               # interactive demo server (port 3001)
scripts/            # standalone runners (analyst, smoke)
data/               # test fixtures, sessions, datasets
```
