import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";

type StreamEvent = Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;

// ── Types ─────────────────────────────────────────────────────────

interface ZenEvent {
  type: string;
  detail: { id: string; [k: string]: unknown };
  event: Record<string, unknown>;
}

// ── Config ────────────────────────────────────────────────────────

const client = new Anthropic();

const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";
const ENVIRONMENT_ID = "env_01BeAimUGVuvGamH6fgfiUTa";

const TICKET_ORDER = ["4800019", "4800027", "4800094", "4800099"];
const TICKET_IDS = new Set(TICKET_ORDER);

const ALLOWED_TYPES = new Set([
  "zen:event-type:ticket.created",
  "zen:event-type:ticket.next_sla_breach_changed",
  "zen:event-type:ticket.group_assignment_changed",
  "zen:event-type:ticket.agent_assignment_changed",
  "zen:event-type:ticket.status_changed",
]);

// ── Data loading ──────────────────────────────────────────────────

const DATA_DIR = join(import.meta.dir, "..", "data", "pintest-v2", "smoke-tickets");

function parseJsonl(text: string): ZenEvent[] {
  return text.trim().split("\n").map((line) => JSON.parse(line) as ZenEvent);
}

function isAllowedEvent(e: ZenEvent): boolean {
  if (!ALLOWED_TYPES.has(e.type)) return false;
  // SLA events: include only "set" (current is non-null), exclude "cleared"
  if (e.type === "zen:event-type:ticket.next_sla_breach_changed") {
    return (e.event as { current: unknown }).current !== null;
  }
  return true;
}

const allEvents = parseJsonl(await Bun.file(join(DATA_DIR, "smoke_events.jsonl")).text());
const filtered = allEvents.filter(
  (e) => TICKET_IDS.has(String(e.detail.id)) && isAllowedEvent(e),
);

const byTicket = new Map<string, ZenEvent[]>();
for (const e of filtered) {
  const id = String(e.detail.id);
  if (!byTicket.has(id)) byTicket.set(id, []);
  byTicket.get(id)!.push(e);
}

console.log(`Loaded ${filtered.length} events across ${byTicket.size} tickets`);

// ── Demo handler ──────────────────────────────────────────────────

async function runDemo(): Promise<Response> {
  const ticketEvents = byTicket.get(TICKET_ORDER[0]);
  if (!ticketEvents) {
    console.error(`No events found for ticket ${TICKET_ORDER[0]}`);
    return new Response("No events for target ticket", { status: 500 });
  }

  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
  });
  console.log(`Session created: ${session.id}`);

  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: JSON.stringify(ticketEvents[0], null, 2) }],
    }],
  });
  console.log(`Sent ticket ${TICKET_ORDER[0]} first event`);

  let agentActive = false;
  let staleSkipped = false;

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5_000);

      try {
        for await (const event of stream) {
          console.log(`[event] ${event.type}  ${JSON.stringify(event).slice(0, 300)}`);

          if (event.type.startsWith("agent.")) agentActive = true;

          if (event.type === "agent.message") {
            const data = JSON.stringify({ type: event.type, content: (event as { content: unknown }).content });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }

          if (event.type === "session.status_idle") {
            // Stream replays current idle status on connect — skip it.
            if (event.stop_reason.type === "end_turn" && !agentActive) {
              if (staleSkipped) {
                console.error("Multiple stale idles — aborting");
                break;
              }
              console.log("Skipped stale idle");
              staleSkipped = true;
              continue;
            }

            if (event.stop_reason.type === "requires_action") {
              const ids = (event.stop_reason as { event_ids?: string[] }).event_ids ?? [];
              console.log(`  requires_action — blocking event IDs: ${ids.join(", ")}`);
              continue;
            }

            console.log("Session idle — done.");
            break;
          }
        }
      } catch (err) {
        console.error("Stream error:", err);
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Server ─────────────────────────────────────────────────────────

const STATIC_DIR = import.meta.dir;

const server = Bun.serve({
  port: Number(process.env.PORT || 3001),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/stream") return runDemo();

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on port ${server.port}`);
