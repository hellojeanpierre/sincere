# sincere

Bun-based AI agent project using `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Runtime

- Bun, not Node.js. Use `bun run`, `bun test`, `bun:sqlite`, `Bun.file`, etc.
- Bun auto-loads `.env` — no dotenv needed.

## Architectural Invariants

1. **Tools are dumb pipes.** A tool takes input, executes, returns output. No reasoning, no analytics logic, no parsing of results, no opinions about what the Operator should do next. All intelligence lives in the Operator's generated input, not in the tool.

2. **One tool, one branching point.** If the Operator makes a meaningfully different decision when choosing between two operations, those are separate tools. Never hide mode-switching inside a parameter.

3. **Skills are context, not code.** A skill is a markdown file the Operator reads before acting. It contains failure modes, heuristics, and domain knowledge that shape the Operator's reasoning. Skills do not execute anything.

4. **Operator prompt is the single source of reasoning.** The file `src/operator.md` is the sole source of agent reasoning principles. Do not scatter system-prompt fragments across code files.

5. **Tools are typed functions, not classes.** Every tool is a plain function with metadata. Schemas are defined with TypeBox (from pi-ai). No class hierarchies, no `BaseTool`.

6. **Structured logging only.** Use `pino` everywhere. No `console.log`, `console.warn`, or `console.error`. Import the shared logger from `src/lib/logger.ts`. Exception: `process.stderr.write()` is allowed for streaming text deltas to the terminal.

7. **Agent config via `initialState`.** Configure the Agent's system prompt, model, and tools through `initialState` in the constructor. This keeps setup declarative and in one place.

## Tool Surface

- **read** — returns file content as text. Unconditionally safe. Used for data files, knowledge graph triples, skill context, configuration.
- **exec** — runs a shell command in a subprocess, returns stdout/stderr. Allowlisted binaries only. Used for computation the Operator cannot do in-context.

## Project Layout

```
src/
  index.ts          # entry point
  operator.md       # agent system prompt (sole source of reasoning principles)
  lib/              # shared utilities (logger, etc.)
  tools/            # tool definitions (typed functions + TypeBox schemas)
  skills/           # markdown files read by Operator for domain context
```
