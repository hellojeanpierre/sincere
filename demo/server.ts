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
  nextEventIndex: number;
}

interface FireResult {
  fired: boolean;
  eventIndex?: number;
  eventType?: string;
  nextEventType?: string;
  reason?: string;
}

interface TurnResult {
  status: "ok" | "timeout" | "error";
  message?: string;
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

const TURN_TIMEOUT_MS = 60_000;
const DRAIN_MS = 5_000;

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
const queue = new Map<string, Promise<void>>();

interface ScheduledCron {
  ticketId: string;
  toolUseEventId: string;
  delayMinutes: number;
  scheduledAt: number;
}

const crons = new Map<string, ScheduledCron>();

// ── SSE broadcast ───────────────────────────────────────────────

type SSEWriter = WritableStreamDefaultWriter<Uint8Array>;
const sseClients = new Set<SSEWriter>();
const encoder = new TextEncoder();

function broadcast(data: Record<string, unknown>): void {
  const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const writer of sseClients) {
    writer.write(chunk).catch(() => {
      sseClients.delete(writer);
      writer.close().catch(() => {});
    });
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

// ── Per-fire stream ─────────────────────────────────────────────

const TIMEOUT = Symbol("timeout");

async function consumeTurn(ticketId: string, stream: AsyncIterable<StreamEvent>): Promise<TurnResult> {
  const ts = sessions.get(ticketId);
  if (!ts) throw new Error(`No session for ticket ${ticketId}`);

  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, Record<string, unknown>>();
  const iter = stream[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<StreamEvent>> | null = null;
  let deadline = Date.now() + TURN_TIMEOUT_MS;
  let interrupted = false;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (!interrupted) {
          interrupted = true;
          console.log(`Timeout: sending user.interrupt for session ${ts.sessionId}`);
          client.beta.sessions.events.send(ts.sessionId, {
            events: [{ type: "user.interrupt" }],
          }).catch((e: unknown) => console.error(`Failed to send interrupt for ${ts.sessionId}:`, e));
          deadline = Date.now() + DRAIN_MS;
          continue;
        }
        const msg = `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s`;
        console.log(`${msg} (session ${ts.sessionId})`);
        broadcast({ ticketId, type: "error", message: msg });
        return { status: "timeout", message: msg };
      }

      if (!pending) pending = iter.next();

      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<typeof TIMEOUT>((r) => {
        timerId = setTimeout(() => r(TIMEOUT), remaining);
      });
      const result = await Promise.race([pending, timeoutP]);
      clearTimeout(timerId);

      if (result === TIMEOUT) continue;

      pending = null;

      if (result.done) {
        if (interrupted) {
          const msg = `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s`;
          console.log(`${msg} — stream closed after interrupt (session ${ts.sessionId})`);
          return { status: "timeout", message: msg };
        }
        const msg = "Stream closed without end_turn";
        console.error(`${msg} (session ${ts.sessionId})`);
        return { status: "error", message: msg };
      }

      const event = result.value;

      if (event.type === "agent.custom_tool_use") {
        const e = event as { id: string; name: string; input: Record<string, unknown> };
        toolNames.set(e.id, e.name);
        toolInputs.set(e.id, e.input);
        broadcast({ ticketId, type: "tool_use", name: e.name, input: e.input });
      }

      if (event.type === "agent.tool_use") {
        const e = event as { name: string; input: Record<string, unknown> };
        broadcast({ ticketId, type: "tool_use", name: e.name, input: e.input });
      }

      if (event.type === "agent.message") {
        broadcast({ ticketId, type: event.type, content: (event as { content: unknown }).content });
      }

      if (event.type === "session.error") {
        const e = event as { error: { message: string; retry_status?: { type: string } } };
        const retryType = e.error.retry_status?.type;
        if (retryType === "exhausted" || retryType === "terminal") {
          broadcast({ ticketId, type: "error", message: e.error.message });
          return { status: "error", message: e.error.message };
        }
        if (retryType !== "retrying") {
          console.error(
            `Unknown session.error retry_status for session ${ts.sessionId}:`,
            JSON.stringify(e.error),
          );
          broadcast({ ticketId, type: "error", message: e.error.message });
          return { status: "error", message: e.error.message };
        }
      }

      if (event.type === "session.status_idle") {
        broadcast({ ticketId, type: "session.status_idle", stopReason: event.stop_reason.type });

        if (event.stop_reason.type === "end_turn") break;

        if (event.stop_reason.type === "requires_action") {
          if (interrupted) break;

          const ids = (event.stop_reason as { event_ids?: string[] }).event_ids ?? [];
          const results: EventParams[] = [];
          for (const id of ids) {
            const name = toolNames.get(id);
            if (name !== "cron") {
              throw new Error(`Unexpected custom tool "${name ?? "unknown"}" (id ${id}) — only "cron" is handled`);
            }
            const input = toolInputs.get(id) ?? {};
            const delayMinutes = Number(input.delay_minutes) || 0;
            const cronId = crypto.randomUUID();
            crons.set(cronId, {
              ticketId,
              toolUseEventId: id,
              delayMinutes,
              scheduledAt: Date.now(),
            });
            broadcast({ type: "cron_scheduled", cronId, ticketId, delayMinutes });
            results.push({
              type: "user.custom_tool_result",
              custom_tool_use_id: id,
              content: [{
                type: "text",
                text: `Cron scheduled. Will fire after ${delayMinutes} minutes. You will receive a follow-up message when it fires.`,
              }],
            });
          }
          await client.beta.sessions.events.send(ts.sessionId, { events: results });
          continue;
        }

        if (event.stop_reason.type === "retries_exhausted") {
          const msg = "Retries exhausted";
          broadcast({ ticketId, type: "error", message: msg });
          return { status: "error", message: msg };
        }
      }
    }
  } finally {
    iter.return?.().catch(() => {});
  }

  if (interrupted) {
    const msg = `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s`;
    return { status: "timeout", message: msg };
  }

  return { status: "ok" };
}

async function fireTicket(ticketId: string): Promise<FireResult> {
  const ticketEvents = byTicket.get(ticketId);
  if (!ticketEvents) throw new Error(`No events for ticket ${ticketId}`);

  let ts = sessions.get(ticketId);

  if (!ts) {
    const fileId = await ensurePolicyFile();
    const session = await client.beta.sessions.create({
      agent: AGENT_ID,
      environment_id: ENVIRONMENT_ID,
      resources: [
        { type: "file", file_id: fileId, mount_path: "/mnt/session/uploads/policy.jsonl" },
      ],
    });
    console.log(`Session created: ${session.id}`);
    ts = { sessionId: session.id, nextEventIndex: 0 };
    sessions.set(ticketId, ts);
  }

  if (ts.nextEventIndex >= ticketEvents.length) {
    return { fired: false, reason: "no more events" };
  }

  const eventIndex = ts.nextEventIndex;
  const event = ticketEvents[eventIndex];

  const stream = await client.beta.sessions.events.stream(ts.sessionId);

  await client.beta.sessions.events.send(ts.sessionId, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    }],
  });
  console.log(`Sent ticket ${ticketId} event ${eventIndex}`);

  ts.nextEventIndex++;
  const result: FireResult = {
    fired: true,
    eventIndex,
    eventType: event.type,
    nextEventType: ticketEvents[ts.nextEventIndex]?.type,
  };

  const turn = await consumeTurn(ticketId, stream);
  if (turn.status !== "ok") result.reason = turn.message;
  return result;
}

async function fireCron(cronId: string, cron: ScheduledCron): Promise<TurnResult> {
  const ts = sessions.get(cron.ticketId);
  if (!ts) {
    return { status: "error", message: `No session for ticket ${cron.ticketId}` };
  }

  const stream = await client.beta.sessions.events.stream(ts.sessionId);

  await client.beta.sessions.events.send(ts.sessionId, {
    events: [{
      type: "user.message",
      content: [{
        type: "text",
        text: `Your cron fired (originally scheduled with delay_minutes=${cron.delayMinutes}). Assess the current ticket state against what you expected when you scheduled it.`,
      }],
    }],
  });
  console.log(`Fired cron ${cronId} for ticket ${cron.ticketId}`);

  return consumeTurn(cron.ticketId, stream);
}

// ── Route handlers ───────────────────────────────────────────────

async function handleCronFire(cronId: string): Promise<Response> {
  const cron = crons.get(cronId);
  if (!cron) return Response.json({ error: "Unknown cron" }, { status: 404 });

  let resolve!: (r: Response) => void;
  const response = new Promise<Response>((r) => { resolve = r; });

  const prev = queue.get(cron.ticketId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const result = await fireCron(cronId, cron);
      if (result.status !== "ok") {
        resolve(Response.json({ fired: false, reason: result.message }, { status: 500 }));
      } else {
        resolve(Response.json({ fired: true }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Cron fire error for ${cronId}:`, err);
      broadcast({ ticketId: cron.ticketId, type: "error", message });
      resolve(Response.json({ fired: false, reason: message }, { status: 500 }));
    } finally {
      crons.delete(cronId);
      broadcast({ type: "cron_fired", cronId });
    }
  }).finally(() => {
    if (queue.get(cron.ticketId) === next) queue.delete(cron.ticketId);
  });
  queue.set(cron.ticketId, next);

  return response;
}

async function handleFire(ticketId: string): Promise<Response> {
  if (!TICKET_IDS.has(ticketId))
    return Response.json({ error: "Unknown ticket" }, { status: 404 });

  let resolve!: (r: Response) => void;
  const response = new Promise<Response>((r) => { resolve = r; });

  const prev = queue.get(ticketId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const result = await fireTicket(ticketId);
      resolve(Response.json(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Fire error for ${ticketId}:`, err);
      broadcast({ ticketId, type: "error", message });
      resolve(Response.json({ fired: false, reason: message }, { status: 500 }));
    }
  }).finally(() => {
    if (queue.get(ticketId) === next) queue.delete(ticketId);
  });
  queue.set(ticketId, next);

  return response;
}

function handleEvents(req: Request): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  sseClients.add(writer);

  const keepalive = setInterval(() => {
    writer.write(encoder.encode(": keepalive\n\n")).catch(() => {});
  }, 5_000);

  req.signal.addEventListener("abort", () => {
    clearInterval(keepalive);
    sseClients.delete(writer);
    writer.close().catch(() => {});
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

    const fireMatch = url.pathname.match(/^\/tickets\/(\d+)\/fire$/);
    if (fireMatch && req.method === "POST") return handleFire(fireMatch[1]);

    const cronFireMatch = url.pathname.match(/^\/crons\/([^/]+)\/fire$/);
    if (cronFireMatch && req.method === "POST") return handleCronFire(cronFireMatch[1]);

    if (url.pathname === "/tickets" && req.method === "GET") {
      const list = TICKET_ORDER.map((id) => {
        const events = byTicket.get(id);
        return {
          ticketId: id,
          subject: typeof events?.[0]?.detail?.subject === "string" && events[0].detail.subject
            ? events[0].detail.subject
            : `Ticket ${id}`,
          firstEventType: events?.[0]?.type,
        };
      });
      return Response.json(list);
    }

    if (url.pathname === "/events") return handleEvents(req);

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = resolve(join(STATIC_DIR, filePath));
    if (!resolved.startsWith(STATIC_DIR + "/") && resolved !== STATIC_DIR) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(resolved);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on port ${server.port}`);
