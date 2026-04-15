import { test, expect } from "bun:test";
import type { SessionEvent } from "./types";

// ── Simulate the event loop logic matching processEvent in run.ts ───

type ToolEvent = { name: string; input: unknown };

/** Replays SessionEvents through the same logic as processEvent's for-await loop. */
function replayEventLoop(
  events: SessionEvent[],
): { outcome: string; toolResultsSent: number } {
  const toolEvents = new Map<string, ToolEvent>();
  let agentActive = false;
  let toolResultsSent = 0;

  for (const event of events) {
    if (event.type.startsWith("agent.")) {
      agentActive = true;
    }

    if (event.type === "agent.custom_tool_use" && "id" in event) {
      const { id, name, input } = event as { id: string; name: string; input: unknown };
      toolEvents.set(id, { name, input });
      continue;
    }

    if (event.type === "session.status_idle") {
      const reason = (event as { stop_reason?: { type: string; event_ids?: string[] } }).stop_reason;

      if (reason?.type === "end_turn" && !agentActive) continue;

      if (reason?.type === "requires_action") {
        toolResultsSent += (reason.event_ids ?? []).length;
        toolEvents.clear();
        continue;
      }
      if (reason?.type === "end_turn") return { outcome: "end_turn", toolResultsSent };

      return { outcome: `unexpected:${reason?.type}`, toolResultsSent };
    }

    if (event.type === "session.status_terminated") {
      return { outcome: "terminated", toolResultsSent };
    }
  }

  return { outcome: "hung", toolResultsSent };
}

// ── Test fixtures using RAW SSE event types (not SDK-transformed) ───

const STREAM_WITH_CRON: SessionEvent[] = [
  // Stale idle on connect
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  // Agent processes (status_running may or may not appear)
  { type: "session.status_running" },
  { type: "agent.message", content: [{ type: "text", text: "Analyzing ticket..." }] },
  { type: "agent.custom_tool_use", id: "evt_abc", name: "cron", input: { delay: "24h" } },
  // Session idles for tool result
  { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_abc"] } },
  // After tool result, agent finishes
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

const STREAM_NO_STATUS_RUNNING: SessionEvent[] = [
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  // No status_running event
  { type: "agent.message", content: [{ type: "text", text: "Analyzing ticket..." }] },
  { type: "agent.custom_tool_use", id: "evt_abc", name: "cron", input: { delay: "24h" } },
  { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_abc"] } },
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

const STREAM_NO_TOOLS: SessionEvent[] = [
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  { type: "session.status_running" },
  { type: "agent.message", content: [{ type: "text", text: "All on track." }] },
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

test("handles cron tool call with status_running present", () => {
  const result = replayEventLoop(STREAM_WITH_CRON);
  expect(result.toolResultsSent).toBe(1);
  expect(result.outcome).toBe("end_turn");
});

test("handles cron tool call WITHOUT status_running", () => {
  const result = replayEventLoop(STREAM_NO_STATUS_RUNNING);
  expect(result.toolResultsSent).toBe(1);
  expect(result.outcome).toBe("end_turn");
});

test("skips stale idle, returns on real end_turn (no tools)", () => {
  const result = replayEventLoop(STREAM_NO_TOOLS);
  expect(result.toolResultsSent).toBe(0);
  expect(result.outcome).toBe("end_turn");
});

test("stale idle alone causes hang (no agent activity)", () => {
  const staleOnly: SessionEvent[] = [
    { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  ];
  const result = replayEventLoop(staleOnly);
  expect(result.outcome).toBe("hung");
});
