import { test, expect } from "bun:test";
import type { SessionEvent } from "./types";

// ── Simulate the event loop logic to test idle-skipping behavior ────

type ToolEvent = { name: string; input: unknown };

/** Replays a sequence of SessionEvents through the same logic as processEvent's for-await loop.
 *  Returns what the loop would do: "requires_action", "end_turn", "unexpected", or "hung" (no exit). */
function replayEventLoop(
  events: SessionEvent[],
  opts: { useRunningGuard: boolean },
): { outcome: string; toolResultsSent: number } {
  const toolEvents = new Map<string, ToolEvent>();
  let running = false;
  let toolResultsSent = 0;

  for (const event of events) {
    if (event.type === "session.status_running") {
      running = true;
      continue;
    }

    if (event.type === "agent.custom_tool_use" && "id" in event) {
      const { id, name, input } = event as { id: string; name: string; input: unknown };
      toolEvents.set(id, { name, input });
      continue;
    }

    // ── This is the guard under test ──
    if (opts.useRunningGuard && event.type === "session.status_idle" && !running) continue;

    if (event.type === "session.status_idle") {
      const reason = (event as { stop_reason?: { type: string; event_ids?: string[] } }).stop_reason;

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

// ── Hypothesis 1: running guard drops requires_action when status_running is absent ──

const STREAM_WITHOUT_RUNNING: SessionEvent[] = [
  // 1. Stale idle on connect (session was idle before our POST)
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  // 2. Agent processes (no explicit status_running event)
  { type: "agent.message", content: [{ type: "text", text: "Analyzing ticket..." }] },
  { type: "agent.custom_tool_use", id: "evt_abc", name: "cron", input: { delay: "24h" } },
  // 3. Session goes idle waiting for tool result
  { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_abc"] } },
  // 4. After tool result, agent finishes
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

const STREAM_WITH_RUNNING: SessionEvent[] = [
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  { type: "session.status_running" },
  { type: "agent.message", content: [{ type: "text", text: "Analyzing ticket..." }] },
  { type: "agent.custom_tool_use", id: "evt_abc", name: "cron", input: { delay: "24h" } },
  { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_abc"] } },
  { type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

test("BUG: running guard skips requires_action when status_running is absent", () => {
  const result = replayEventLoop(STREAM_WITHOUT_RUNNING, { useRunningGuard: true });
  // The guard causes requires_action to be skipped — 0 tool results sent, loop exits on the stale idle's end_turn
  expect(result.toolResultsSent).toBe(0);
  expect(result.outcome).not.toBe("end_turn"); // it actually hits "hung" since stale idle is also skipped
});

test("running guard works when status_running IS present", () => {
  const result = replayEventLoop(STREAM_WITH_RUNNING, { useRunningGuard: true });
  expect(result.toolResultsSent).toBe(1);
  expect(result.outcome).toBe("end_turn");
});

test("without running guard, stale idle causes premature end_turn", () => {
  const result = replayEventLoop(STREAM_WITHOUT_RUNNING, { useRunningGuard: false });
  // First event is stale idle with end_turn — exits immediately
  expect(result.toolResultsSent).toBe(0);
  expect(result.outcome).toBe("end_turn");
});

// ── The fix: skip idle end_turn only BEFORE any agent activity, not requires_action ──

function replayEventLoopFixed(events: SessionEvent[]): { outcome: string; toolResultsSent: number } {
  const toolEvents = new Map<string, ToolEvent>();
  let agentActive = false;
  let toolResultsSent = 0;

  for (const event of events) {
    // Any agent event means the session is processing our message.
    if (event.type.startsWith("agent.")) agentActive = true;

    if (event.type === "agent.custom_tool_use" && "id" in event) {
      const { id, name, input } = event as { id: string; name: string; input: unknown };
      toolEvents.set(id, { name, input });
      continue;
    }

    if (event.type === "session.status_idle") {
      const reason = (event as { stop_reason?: { type: string; event_ids?: string[] } }).stop_reason;

      // Skip stale end_turn from before our message — but NEVER skip requires_action.
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

test("FIXED: handles requires_action even without status_running", () => {
  const result = replayEventLoopFixed(STREAM_WITHOUT_RUNNING);
  expect(result.toolResultsSent).toBe(1);
  expect(result.outcome).toBe("end_turn");
});

test("FIXED: handles requires_action with status_running present", () => {
  const result = replayEventLoopFixed(STREAM_WITH_RUNNING);
  expect(result.toolResultsSent).toBe(1);
  expect(result.outcome).toBe("end_turn");
});

test("FIXED: skips stale end_turn idle on connect", () => {
  const staleOnly: SessionEvent[] = [
    { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    { type: "session.status_running" },
    { type: "agent.message", content: [{ type: "text", text: "done" }] },
    { type: "session.status_idle", stop_reason: { type: "end_turn" } },
  ];
  const result = replayEventLoopFixed(staleOnly);
  expect(result.outcome).toBe("end_turn");
  expect(result.toolResultsSent).toBe(0);
});
