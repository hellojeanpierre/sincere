import { join } from "path";
import {
  loadSpikeEnv,
  apiPost,
  apiDelete,
  apiStream,
  parseSSE,
  parseJsonl,
  makeEventLabel,
  DEMO_TICKET_IDS,
  ALLOWED_EVENT_TYPES,
  DEMO_TICKET_ORDER,
  type ZenEvent,
} from "./types";

// ── Load spike.env ──────────────────────────────────────────────────

const envText = await Bun.file("spike.env").text();
for (const line of envText.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key] = rest.join("=");
}
const { AGENT_ID, ENVIRONMENT_ID } = loadSpikeEnv();

// ── Load & filter events (same logic as demo/server.ts) ─────────────

const EVENTS_PATH = join(import.meta.dir, "..", "..", "data", "pintest-v2", "smoke-tickets", "smoke_events.jsonl");
const allEvents = parseJsonl<ZenEvent>(await Bun.file(EVENTS_PATH).text());
const filtered = allEvents.filter(
  (e) => ALLOWED_EVENT_TYPES.has(e.type) && DEMO_TICKET_IDS.has(String(e.detail.id)),
);

// Group by ticket, ordered by DEMO_TICKET_ORDER
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

// ── Session ─────────────────────────────────────────────────────────

const session = await apiPost<{ id: string }>("/sessions", {
  agent: AGENT_ID,
  environment_id: ENVIRONMENT_ID,
});
console.log("Session:", session.id);

// Single stream open for the whole run
const streamRes = await apiStream(`/sessions/${session.id}/stream`);
if (!streamRes.ok || !streamRes.body) {
  throw new Error(`Stream failed: ${streamRes.status} ${await streamRes.text()}`);
}
const sseReader = parseSSE(streamRes.body.getReader());

// ── Process events (matches demo ticket→event ordering) ─────────────

async function waitForIdle(): Promise<void> {
  for await (const event of sseReader) {
    if (event.type === "session.status_idle") return;
    if (event.type === "session.status_terminated") throw new Error("Session terminated");
  }
}

const announced = new Set<string>();

try {
  for (const ticketEvents of ticketGroups) {
    const ticketId = String(ticketEvents[0].detail.id);
    const subject = String(ticketEvents[0].detail.subject ?? "");

    for (const event of ticketEvents) {
      if (!announced.has(ticketId)) {
        announced.add(ticketId);
        console.log(`\n━━ Ticket ${ticketId}: ${subject} ━━`);
      }

      console.log(`\n▸ ${makeEventLabel(event)}`);

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
  }

  console.log("\n━━ done ━━");
} finally {
  console.log(`Deleting session ${session.id}…`);
  await apiDelete(`/sessions/${session.id}`);
}
