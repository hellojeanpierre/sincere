import { join, resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";
import { ensureCronTool } from "./cron";

type StreamEvent = Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;
type EventParams = Beta.Sessions.Events.BetaManagedAgentsEventParams;

// ── Types ─────────────────────────────────────────────────────────

interface ZenEvent {
  type: string;
  detail: { id: string; [k: string]: unknown };
  event: Record<string, unknown>;
}

interface TicketSession {
  sessionId: string;
  stream: AsyncIterable<StreamEvent>;
  cursor: number;
  cronMap: Map<string, { name: string; input: Record<string, unknown> }>;
  scheduledCron: boolean;
  status: "idle" | "processing";
}

interface FireResult {
  fired: boolean;
  eventIndex?: number;
  eventType?: string;
  reason?: string;
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
const POLICY_PATH = join(DATA_DIR, "policy.jsonl");

function parseJsonl(text: string): ZenEvent[] {
  return text.trim().split("\n").map((line) => JSON.parse(line) as ZenEvent);
}

function isAllowedEvent(e: ZenEvent): boolean {
  if (!ALLOWED_TYPES.has(e.type)) return false;
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

await ensureCronTool(client, AGENT_ID);

// ── Session state ────────────────────────────────────────────────

const sessions = new Map<string, TicketSession>();

// ── SSE broadcast ───────────────────────────────────────────────

const sseClients = new Set<ReadableStreamDefaultController>();

function broadcast(data: Record<string, unknown>): void {
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const c of sseClients) {
    try { c.enqueue(chunk); } catch { sseClients.delete(c); }
  }
}

let cachedFileId: string | null = null;

async function ensurePolicyFile(): Promise<string> {
  if (cachedFileId) return cachedFileId;
  const blob = Bun.file(POLICY_PATH);
  const meta = await client.beta.files.upload({
    file: new File([await blob.arrayBuffer()], "policy.jsonl", { type: blob.type }),
  });
  cachedFileId = meta.id;
  console.log(`Uploaded policy.jsonl: ${meta.id}`);
  return meta.id;
}

// ── Session lifecycle ────────────────────────────────────────────

async function createTicketSession(ticketId: string): Promise<void> {
  const ticketEvents = byTicket.get(ticketId);
  if (!ticketEvents) throw new Error(`No events for ticket ${ticketId}`);

  const fileId = await ensurePolicyFile();

  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    resources: [
      { type: "file", file_id: fileId, mount_path: "/mnt/session/uploads/policy.jsonl" },
    ],
  });
  console.log(`Session created: ${session.id}`);

  const stream = await client.beta.sessions.events.stream(session.id);

  const ts: TicketSession = {
    sessionId: session.id,
    stream,
    cursor: 1,
    cronMap: new Map(),
    scheduledCron: false,
    status: "processing",
  };
  sessions.set(ticketId, ts);

  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: JSON.stringify(ticketEvents[0], null, 2) }],
    }],
  });
  console.log(`Sent ticket ${ticketId} first event`);

  consumeStream(ticketId);
}

async function fireNextEvent(ticketId: string): Promise<FireResult> {
  const ts = sessions.get(ticketId);
  if (!ts) {
    await createTicketSession(ticketId);
    const ev = byTicket.get(ticketId)![0];
    return { fired: true, eventIndex: 0, eventType: ev.type };
  }
  if (ts.status === "processing") {
    return { fired: false, reason: "agent is processing" };
  }
  const ticketEvents = byTicket.get(ticketId);
  if (!ticketEvents || ts.cursor >= ticketEvents.length) {
    return { fired: false, reason: "no more events" };
  }

  const eventType = ticketEvents[ts.cursor].type;
  const eventIndex = ts.cursor;
  ts.status = "processing";

  try {
    await client.beta.sessions.events.send(ts.sessionId, {
      events: [{
        type: "user.message",
        content: [{ type: "text", text: JSON.stringify(ticketEvents[ts.cursor], null, 2) }],
      }],
    });
  } catch (err) {
    ts.status = "idle";
    throw err;
  }
  ts.cursor++;
  return { fired: true, eventIndex, eventType };
}

// ── Stream consumer ──────────────────────────────────────────────

async function consumeStream(ticketId: string): Promise<void> {
  const ts = sessions.get(ticketId);
  if (!ts) throw new Error(`No session for ticket ${ticketId}`);

  const ticketEvents = byTicket.get(ticketId)!;
  let agentActive = false;
  let staleSkipped = false;

  try {
    for await (const event of ts.stream) {
      if (event.type.startsWith("agent.")) agentActive = true;

      if (event.type === "agent.custom_tool_use") {
        const e = event as { id: string; name: string; input: Record<string, unknown> };
        ts.cronMap.set(e.id, { name: e.name, input: e.input });
      }

      if (event.type === "agent.message") {
        broadcast({ ticketId, type: event.type, content: (event as { content: unknown }).content });
      }

      if (event.type === "session.status_idle") {
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
          const results: EventParams[] = [];
          for (const id of ids) {
            const tool = ts.cronMap.get(id);
            let text: string;
            if (!tool) {
              console.error(`Unknown event ID in requires_action: ${id}`);
              text = `Error: unknown event ${id}`;
            } else if (tool.name === "cron") {
              ts.scheduledCron = true;
              text = "Acknowledged. Check-in registered.";
            } else {
              console.error(`Unknown custom tool: ${tool.name}`);
              text = `Error: unknown tool "${tool.name}"`;
            }
            ts.cronMap.delete(id);
            results.push({
              type: "user.custom_tool_result",
              custom_tool_use_id: id,
              content: [{ type: "text", text }],
            });
          }
          await client.beta.sessions.events.send(ts.sessionId, { events: results });
          continue;
        }

        if (ts.scheduledCron) {
          ts.scheduledCron = false;
          await client.beta.sessions.events.send(ts.sessionId, {
            events: [{
              type: "user.message",
              content: [{
                type: "text",
                text: "Cron fired — reassess this ticket's current state.\n\n"
                  + JSON.stringify(ticketEvents, null, 2),
              }],
            }],
          });
          continue;
        }

        // Agent finished this turn — mark idle but keep consuming
        ts.status = "idle";
        agentActive = false;
      }
    }
  } catch (err) {
    ts.status = "idle";
    console.error("Stream error:", err);
  }
}

// ── Route handlers ───────────────────────────────────────────────

function handleEvents(): Response {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController;
  const readable = new ReadableStream({
    start(controller) {
      ctrl = controller;
      sseClients.add(ctrl);
      const keepalive = setInterval(() => {
        try { ctrl.enqueue(encoder.encode(": keepalive\n\n")); }
        catch { clearInterval(keepalive); sseClients.delete(ctrl); }
      }, 5_000);
    },
    cancel() {
      sseClients.delete(ctrl);
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

async function handleFire(ticketId: string): Promise<Response> {
  if (!TICKET_IDS.has(ticketId)) {
    return Response.json({ fired: false, reason: "unknown ticket" }, { status: 404 });
  }
  if (!byTicket.has(ticketId)) {
    return Response.json({ fired: false, reason: "no events for ticket" }, { status: 404 });
  }

  const result = await fireNextEvent(ticketId);
  return Response.json(result);
}

// ── Server ─────────────────────────────────────────────────────────

const STATIC_DIR = import.meta.dir;

const server = Bun.serve({
  port: Number(process.env.PORT || 3001),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/events") return handleEvents();

    const fireMatch = url.pathname.match(/^\/tickets\/(\d+)\/fire$/);
    if (fireMatch && req.method === "POST") return handleFire(fireMatch[1]);

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = resolve(join(STATIC_DIR, filePath));
    if (!resolved.startsWith(STATIC_DIR + "/") && resolved !== STATIC_DIR) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(resolved);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on port ${server.port}`);
