import { join } from "path";
import {
  AGENT_ID,
  ENVIRONMENT_ID,
  apiPost,
  apiUploadFile,
  apiStream,
  parseJsonl,
  makeEventLabel,
  DEMO_TICKET_IDS,
  ALLOWED_EVENT_TYPES,
  DEMO_TICKET_ORDER,
  type ZenEvent,
} from "./types";
import { handleCronTool } from "./cron";

// ── Load & filter events (same logic as demo/server.ts) ─────────────

const DATA_DIR = join(import.meta.dir, "..", "..", "data", "pintest-v2", "smoke-tickets");
const EVENTS_PATH = join(DATA_DIR, "smoke_events.jsonl");
const POLICY_PATH = join(DATA_DIR, "policy.jsonl");

const allEvents = parseJsonl<ZenEvent>(await Bun.file(EVENTS_PATH).text());
const filtered = allEvents.filter(
  (e) => ALLOWED_EVENT_TYPES.has(e.type) && DEMO_TICKET_IDS.has(String(e.detail.id)),
);

const byId = new Map<string, ZenEvent[]>();
for (const e of filtered) {
  const id = String(e.detail.id);
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id)!.push(e);
}
const ticketGroups: ZenEvent[][] = [];
for (const id of DEMO_TICKET_ORDER) {
  const events = byId.get(id);
  if (events) ticketGroups.push(events);
}

console.log(`Loaded ${filtered.length} events across ${ticketGroups.length} tickets`);

// ── Upload policy file once, mount into each session ────────────────

const policyFile = await apiUploadFile(POLICY_PATH);
console.log(`Uploaded policy.jsonl: ${policyFile.id}\n`);

// ── Event processing ────────────────────────────────────────────────

async function processEvent(sessionId: string, message: string): Promise<void> {
  // Open the stream BEFORE posting so we don't miss events.
  // Docs: "Only events emitted after the stream is opened are delivered."
  const stream = await apiStream(sessionId);

  try {
    await apiPost(`/sessions/${sessionId}/events`, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: message }],
        },
      ],
    });
  } catch (err) {
    console.error(`  !! processEvent POST failed for session ${sessionId}:`, err);
    throw err;
  }

  const toolEvents = new Map<string, { name: string; input: unknown }>();
  let agentActive = false;

  for await (const event of stream) {
    // Any agent-originated event means the session is processing our message.
    // Raw SSE types: "agent", "agent_tool_use", "custom_tool_use", etc.
    if (event.type === "agent" || event.type.startsWith("agent_") || event.type === "custom_tool_use") {
      agentActive = true;
    }

    if (event.type === "custom_tool_use" && "id" in event) {
      const { id, name, input } = event as { id: string; name: string; input: unknown };
      toolEvents.set(id, { name, input });
      continue;
    }

    if (event.type === "status_idle") {
      const reason = (event as { stop_reason?: { type: string; event_ids?: string[] } }).stop_reason;

      // Skip stale end_turn from before our message — but NEVER skip requires_action.
      if (reason?.type === "end_turn" && !agentActive) continue;

      if (reason?.type === "requires_action") {
        const results = [];
        for (const eventId of reason.event_ids ?? []) {
          const tool = toolEvents.get(eventId);
          let resultText: string;
          if (!tool) {
            resultText = `Error: unknown tool event ${eventId}`;
          } else if (tool.name === "cron") {
            resultText = handleCronTool(
              sessionId,
              tool.input as { delay?: string },
              processEvent,
            );
          } else {
            resultText = `Error: unknown custom tool "${tool.name}"`;
          }

          results.push({
            type: "user.custom_tool_result",
            custom_tool_use_id: eventId,
            content: [{ type: "text", text: resultText }],
          });
        }
        await apiPost(`/sessions/${sessionId}/events`, { events: results });
        toolEvents.clear();
        continue;
      }

      if (reason?.type === "end_turn") return;

      console.error(`  !! unexpected stop_reason: ${reason?.type ?? "none"}`);
      return;
    }

    if (event.type === "status_terminated") {
      throw new Error("Session terminated unexpectedly");
    }
  }
}

// ── Process one ticket per session ──────────────────────────────────

async function processTicket(events: ZenEvent[]): Promise<void> {
  const ticketId = String(events[0].detail.id);
  const subject = String(events[0].detail.subject ?? "");
  console.log(`\n━━ Ticket ${ticketId}: ${subject} ━━`);

  const session = await apiPost<{ id: string; resources?: { mount_path: string }[] }>("/sessions", {
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    resources: [
      { type: "file", file_id: policyFile.id, mount_path: "/policy.jsonl" },
    ],
  });
  console.log(`  Session: ${session.id}`);
  console.log(`  Resources: ${JSON.stringify(session.resources)}`);

  for (const event of events) {
    console.log(`  ▸ ${makeEventLabel(event)}`);
    await processEvent(session.id, `Incoming Zendesk event:\n\n${JSON.stringify(event, null, 2)}`);
  }
}

for (const ticketEvents of ticketGroups) {
  await processTicket(ticketEvents);
}

console.log("\n━━ done ━━");
