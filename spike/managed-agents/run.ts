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

const flatEvents: ZenEvent[] = ticketGroups.flat();
console.log(`Loaded ${flatEvents.length} events across ${ticketGroups.length} tickets`);

// ── Gate (same pattern as demo/server.ts) ───────────────────────────

let resolveNext: (() => void) | null = null;
let pendingNext = 0;

function waitForNext(): Promise<void> {
  if (pendingNext > 0) { pendingNext--; return Promise.resolve(); }
  return new Promise((r) => { resolveNext = r; });
}

function signalNext(): void {
  if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
  else { pendingNext++; }
}

// ── SSE helpers ─────────────────────────────────────────────────────

type SSESend = (event: string, data: Record<string, unknown>) => void;

function eventStream(run: (send: SSESend) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send: SSESend = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5_000);
      try {
        await run(send);
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Server ──────────────────────────────────────────────────────────

const server = Bun.serve({
  port: Number(process.env.PORT || 3002),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/next" && req.method === "POST") {
      signalNext();
      return new Response("ok");
    }

    if (url.pathname === "/api/stream") {
      return eventStream(async (send) => {
        const session = await apiPost<{ id: string }>("/sessions", {
          agent: AGENT_ID,
          environment_id: ENVIRONMENT_ID,
        });
        console.log("Session:", session.id);

        const streamRes = await apiStream(`/sessions/${session.id}/stream`);
        if (!streamRes.ok || !streamRes.body) {
          throw new Error(`Stream failed: ${streamRes.status} ${await streamRes.text()}`);
        }
        const sseReader = parseSSE(streamRes.body.getReader());

        async function waitForIdle(): Promise<void> {
          for await (const event of sseReader) {
            if (event.type === "session.status_idle") return;
            if (event.type === "session.status_terminated") throw new Error("Session terminated");
          }
        }

        const announced = new Set<string>();

        try {
          for (const event of flatEvents) {
            await waitForNext();

            const ticketId = String(event.detail.id);
            const subject = String(event.detail.subject ?? "");

            if (!announced.has(ticketId)) {
              announced.add(ticketId);
              send("ticket", { id: ticketId, subject });
            }

            const label = makeEventLabel(event);
            send("event", { ticketId, label });

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
            send("idle", {});
          }

          send("done", {});
        } catch (err) {
          send("error_msg", { message: err instanceof Error ? err.message : String(err) });
        } finally {
          console.log(`Deleting session ${session.id}…`);
          await apiDelete(`/sessions/${session.id}`);
        }
      });
    }

    // Static
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(import.meta.dir, filePath));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
