Standalone Bun HTTP gateway that ingests events and drives managed-agent sessions against them.

## Runtime
- Dep: `@anthropic-ai/sdk@0.89.0` (pinned for managed agents beta)
- Run: `bun run pilot/gateway.ts`
- Test: `bun run pilot/test.ts`
- Verify: `PILOT_ALLOW_TEST_INGEST=1 bun run pilot/gateway.ts`, then `curl -X POST http://localhost:3000/test`
