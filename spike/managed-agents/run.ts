import { join } from "path";
import {
  AGENT_ID,
  ENVIRONMENT_ID,
  apiPost,
  apiDelete,
  apiInterrupt,
  apiStream,
  parseSSE,
  parseJsonl,
  makeEventLabel,
  DEMO_TICKET_IDS,
  ALLOWED_EVENT_TYPES,
  DEMO_TICKET_ORDER,
  type ZenEvent,
} from "./types";

// ── Load & filter events (same logic as demo/server.ts) ─────────────

const EVENTS_PATH = join(import.meta.dir, "..", "..", "data", "pintest-v2", "smoke-tickets", "smoke_events.jsonl");
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

console.log(`Loaded ${filtered.length} events across ${ticketGroups.length} tickets\n`);

// ── Process one ticket per session ──────────────────────────────────

async function processTicket(events: ZenEvent[]): Promise<void> {
  const ticketId = String(events[0].detail.id);
  const subject = String(events[0].detail.subject ?? "");
  console.log(`\n━━ Ticket ${ticketId}: ${subject} ━━`);

  const session = await apiPost<{ id: string }>("/sessions", {
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
  });
  console.log(`  Session: ${session.id}`);

  const streamRes = await apiStream(`/sessions/${session.id}/stream`);
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`Stream failed: ${streamRes.status} ${await streamRes.text()}`);
  }
  const sseReader = parseSSE(streamRes.body.getReader());

  async function waitForIdle(): Promise<void> {
    for await (const event of sseReader) {
      switch (event.type) {
        case "session.status_idle":
          return;
        case "session.status_running":
          break;
        case "session.status_terminated":
          throw new Error("Session terminated");
        case "session.error":
          console.error(`  [error] ${event.error?.message ?? "unknown"}`);
          break;
        case "session.status_rescheduled":
          console.log("  [rescheduled] transient error, retrying…");
          break;
        case "agent.tool_use":
          console.log(`    [tool] ${event.name}`);
          break;
        case "agent.message":
          for (const block of event.content ?? []) {
            if (block.type === "text" && block.text) {
              console.log(`    ${block.text.slice(0, 200)}`);
            }
          }
          break;
        default:
          process.stderr.write(".");
          break;
      }
    }
  }

  try {
    for (const event of events) {
      console.log(`\n  ▸ ${makeEventLabel(event)}`);

      await apiPost(`/sessions/${session.id}/events`, {
        events: [
          {
            type: "user.message",
            content: [
              { type: "text", text: `Incoming Zendesk event:\n\n${JSON.stringify(event, null, 2)}` },
            ],
          },
        ],
      });

      await waitForIdle();
    }
  } finally {
    console.log(`  Cleaning up session ${session.id}…`);
    await apiInterrupt(session.id).catch(() => {});
    await apiDelete(`/sessions/${session.id}`).catch(() => {});
  }
}

for (const ticketEvents of ticketGroups) {
  await processTicket(ticketEvents);
}

console.log("\n━━ done ━━");
