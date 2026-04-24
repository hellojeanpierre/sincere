# sincere

AI agent system for autonomous operational improvement. Bun/TypeScript.

## How We Build

- Subtraction over addition (YAGNI). New abstractions pay their complexity cost now; the future they're built for usually never arrives. When solving a problem, first try removing code.
- Gall's Law. A complex system designed from scratch never works. Start with the smallest working version — layers and generalization earn their place only after the simple version is working.
- Fail fast. When something fails, the caller should know immediately. Do not swallow errors, return undefined as a fallback, or add defaults that mask failures.
- Evals test agent behavior, unit tests test infra. Never assert on model output in a unit test.

## Codebase

- `pilot/` — Pinterest shadow-mode pilot (active). Has its own CLAUDE.md.
- `src/` — original agent runtime (dormant). Has its own CLAUDE.md.
- `demo/` — interactive demo server. Has its own CLAUDE.md.
- `evals/` — eval harnesses.
- `data/` — test fixtures, sessions, datasets.

## Runtime

- Bun, not Node.js. Use `bun run`, `bun test`, `bun:sqlite`, `Bun.file`.
- Bun auto-loads `.env` from project root. Do not add manual `.env` loaders.
