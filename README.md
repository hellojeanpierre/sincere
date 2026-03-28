# sincere

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Anthropic API key |
| `MODEL` | `claude-sonnet-4-6` | Model ID passed to the API |
| `SKILL` | *(none)* | Load only this skill file (e.g. `SKILL=data-analysis`). When unset, all skills in `src/skills/` are loaded. |

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
