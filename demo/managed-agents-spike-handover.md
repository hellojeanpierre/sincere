# Managed Agents — Reference for Claude Code Sessions

Use this as context when working on the managed agents spike. It covers the API surface, the event model, and the traps that cost us time yesterday.

---

## SDK & Auth

Package: `@anthropic-ai/sdk`. The SDK sets the beta header `managed-agents-2026-04-01` automatically — do not set `anthropic-beta` or `anthropic-version` by hand. The `ANTHROPIC_API_KEY` env var is picked up by the constructor. The entire API surface lives under `client.beta`.

---

## Core Concepts

There are four primitives. Agent and Environment are pre-created — we have IDs for both.

**Agent** — versioned config: model, system prompt, tools, skills. Immutable per version; updates create a new version. Pass agent ID as a string to get latest version, or as `{ type: "agent", id, version }` to pin.

**Environment** — container template: packages, networking. Not versioned. Each session gets its own isolated container instance.

**Session** — a running agent+environment instance. Stateful: conversation history persists server-side. Creating a session does NOT start work — it starts in `idle`. Work begins only when you send a `user.message` event.

**Events** — the only communication channel. You send user events, you receive agent/session/span events via SSE. Fire-and-stream, not request/response.

---

## Session Lifecycle

1. **Create** — `client.beta.sessions.create({ agent: AGENT_ID, environment_id: ENV_ID })` → returns `session.id`, status is `idle`.
2. **Open stream** — `client.beta.sessions.events.stream(session.id)` → async iterable of SSE events. **Must open BEFORE sending events** — events emitted before stream opens are lost to that connection.
3. **Send event** — `client.beta.sessions.events.send(session.id, { events: [...] })` → the `events` field is always an array, even for single events.
4. **Consume stream** — iterate, dispatch on `event.type`.
5. **Follow-up** — send more `user.message` events to the same session. No history replay needed.
6. **Cleanup** — `client.beta.sessions.archive(session.id)` (read-only) or `.delete(session.id)` (nuke).

### Session Statuses

`idle` → waiting for input (including custom tool results). `running` → agent is working. `rescheduling` → transient error, auto-retrying. `terminated` → unrecoverable.

---

## Event Types

### Events You Send

| Type | Purpose |
|------|---------|
| `user.message` | Send text/document/image content. Starts or continues work. |
| `user.interrupt` | Stop agent mid-execution. |
| `user.custom_tool_result` | Return result for a custom tool call. Key field: `custom_tool_use_id`. |
| `user.tool_confirmation` | Approve/deny a built-in or MCP tool call (only if permission policy requires it). |

### Events You Receive

| Type | Key Fields | Notes |
|------|-----------|-------|
| `agent.message` | `.content[]` (text blocks) | Agent's text response. |
| `agent.thinking` | — | Progress signal, no content. |
| `agent.tool_use` | `.name`, `.input` | Built-in tool invoked (bash, read, write, etc). |
| `agent.tool_result` | `.tool_use_id`, `.content[]` | Result of built-in tool. |
| `agent.custom_tool_use` | `.id`, `.name`, `.input` | **Your custom tool was called.** The `.id` is the event ID you must return in `custom_tool_use_id`. |
| `session.status_idle` | `.stop_reason` | Agent stopped. Check `stop_reason.type` — see below. |
| `session.status_running` | — | Agent is actively working. |
| `session.error` | `.error.message`, `.error.retry_status` | Check `retry_status.type`: `retrying` (wait), `exhausted` (turn is dead, send new prompt), `terminal` (session is done). |
| `span.model_request_start` | — | Model inference started. |
| `span.model_request_end` | `.model_usage` | Token counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. |

### Stop Reasons (on `session.status_idle`)

| `stop_reason.type` | Meaning | Action |
|---------------------|---------|--------|
| `end_turn` | Agent finished naturally. | Done, or send next message. |
| `requires_action` | Waiting for custom tool result(s). | `.event_ids` lists which. Send `user.custom_tool_result` for each. |
| `retries_exhausted` | Hit retry budget or max iterations. | Treat as soft failure. |

---

## Custom Tool Flow (Cron)

We define the custom tool on the agent (schema is already in place). At runtime:

1. Stream emits `agent.custom_tool_use` — store event in a map keyed by `.id`.
2. Stream emits `session.status_idle` with `stop_reason.type === "requires_action"` — `.event_ids` tells you which events are blocking.
3. Look up each event ID in your map. Execute the tool. Send back:
   ```
   events: [{
     type: "user.custom_tool_result",
     custom_tool_use_id: <the event .id from step 1>,
     content: [{ type: "text", text: "result here" }]
   }]
   ```
4. Session resumes to `running`.

**The "awaken" pattern:** when the cron fires, send a `user.message` to the same session. It has full context.

**Critical:** `custom_tool_use_id` is the **event's `.id`**, not the tool name. This is distinct from Messages API `tool_use` blocks. This was likely yesterday's main issue.

---

## Providing policies.jsonl via Files API

The Files API (`client.beta.files`) lets you upload once and reference by ID across all sessions. It requires its own beta header: `files-api-2025-04-14`.

### Upload (once, at startup)

```
const uploaded = await client.beta.files.upload({
  file: <File object for policies.jsonl>,
  betas: ["files-api-2025-04-14"]
})
// uploaded.id → "file_xxxx"
```

The SDK's `upload` takes a `File`-like object. With Bun, use `Bun.file("policies.jsonl")` or build a `File` from a `ReadableStream`. The MIME type for JSONL is `text/plain`.

### Reference in session events

In the `user.message` content array, use a document block with `source.type: "file"`:

```
content: [
  {
    type: "document",
    source: { type: "file", file_id: uploaded.id },
    title: "policies.jsonl",
    context: "Reference policies for ticket resolution"
  },
  { type: "text", text: "Handle this ticket: ..." }
]
```

The Managed Agents event schema explicitly supports `BetaManagedAgentsFileDocumentSource` with `{ type: "file", file_id }` in document blocks. Upload once, reference across all 4 sessions by reusing the same `file_id`.

### Lifecycle

Files persist until you delete them. Scoped to workspace. Free to upload/manage — only costs input tokens when referenced in a message. Max 500MB per file.

---

## Updating the Agent (if needed)

To add/change tools or system prompt:

```
client.beta.agents.update(AGENT_ID, {
  version: currentVersion,  // required, optimistic concurrency
  tools: [...]              // replaces entire tools array
})
```

Omitted fields are preserved. Scalar fields are replaced. Array fields (`tools`, `skills`, `mcp_servers`) are fully replaced — you must pass the complete array. If the update is a no-op, no new version is created.

New sessions pick up the latest version by default. Running sessions are unaffected.

---

## Streaming Patterns

### Basic: stream then send

Open the stream first, send the event second. Events emitted before the stream opens are not delivered to that stream.

### Reconnect: deduplicate with seen IDs

If the stream disconnects, open a new one, then call `client.beta.sessions.events.list(sessionId)` to get full history. Build a `Set<string>` of seen event IDs, skip duplicates from the live stream. The docs show this pattern explicitly.

### Listing past events

`client.beta.sessions.events.list(sessionId)` returns paginated event history. Useful for debugging and reconnection.

---

## What We're NOT Using

MCP servers, skills, vaults/OAuth, multi-agent/callable_agents, outcomes, permission policies (default is `always_allow`), environment packages (already configured).

---

## The Six SDK Calls

| Call | When |
|------|------|
| `client.beta.files.upload(...)` | Once at startup for policies.jsonl |
| `client.beta.sessions.create(...)` | Once per ticket (4 total) |
| `client.beta.sessions.events.stream(...)` | After each session create |
| `client.beta.sessions.events.send(...)` | To send `user.message` and `user.custom_tool_result` |
| `client.beta.sessions.retrieve(...)` | Optional, check status |
| `client.beta.sessions.archive(...)` | Cleanup |

Plus `client.beta.agents.update(...)` once if the tool definition needs changes.

---

## Debugging

The Anthropic Console has a session debugging UI — inspect by session ID. Full event timeline, tool calls, agent reasoning. Log session IDs to Pino on creation. That's the debugging handle. No custom tracing needed for the demo.
