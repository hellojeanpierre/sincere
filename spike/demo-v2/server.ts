import { join } from "path";
import { mkdirSync } from "fs";
import { createAgent, createSessionHandler } from "../../src/agent.ts";
import { createLane } from "../../src/lane.ts";
import { logger, startTraceSink } from "../../src/lib/logger.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

const TRACES_DIR = join(import.meta.dir, "../..", "data", "traces");

const log = logger.child({ component: "demo" });

// ── Constants ───────────────────────────────────────────────────────

const OPERATOR_PROMPT_PATH = join(import.meta.dir, "../../src/operator.md");
const STATIC_DIR = import.meta.dir;

const DATA_DIR = join(import.meta.dir, "../..", "data", "pintest-v2", "smoke-tickets");
const EVENTS_PATH = join(DATA_DIR, "smoke_events.jsonl");
const TICKETS_PATH = join(DATA_DIR, "smoke_tickets.jsonl");
const POLICY_PATH = join(DATA_DIR, "policy.jsonl");

const DEMO_TICKET_IDS = new Set(["4800019", "4800027", "4800094", "4800099"]);
const ALLOWED_EVENT_TYPES = new Set([
  "zen:event-type:ticket.created",
  "zen:event-type:ticket.group_assignment_changed",
  "zen:event-type:ticket.agent_assignment_changed",
  "zen:event-type:ticket.status_changed",
]);

// ── Data loading ────────────────────────────────────────────────────

type ZenEvent = {
  type: string;
  detail: Record<string, unknown>;
  [key: string]: unknown;
};

function parseJsonl<T>(text: string): T[] {
  return text.trim().split("\n").map((line) => JSON.parse(line) as T);
}

const allEvents = parseJsonl<ZenEvent>(await Bun.file(EVENTS_PATH).text());
const demoEventsRaw = allEvents.filter(
  (e) => ALLOWED_EVENT_TYPES.has(e.type) && DEMO_TICKET_IDS.has(String(e.detail.id)),
);

// Group events by ticket, streamed in explicit narrative order:
// 1. Clean baseline (good CSAT) → 2–4. Progressively complex failures.
const DEMO_TICKET_ORDER = ["4800019", "4800027", "4800094", "4800099"];
const demoEventsByTicket: ZenEvent[][] = [];
{
  const byId = new Map<string, ZenEvent[]>();
  for (const e of demoEventsRaw) {
    const id = String(e.detail.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(e);
  }
  for (const id of DEMO_TICKET_ORDER) {
    const events = byId.get(id);
    if (events) demoEventsByTicket.push(events);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeEventLabel(event: ZenEvent): string {
  const type = event.type;
  const detail = event.detail;
  if (type.endsWith("ticket.created")) return "ticket created";
  if (type.endsWith("ticket.status_changed")) return `status → ${String(detail.status || "").toLowerCase()}`;
  if (type.endsWith("ticket.agent_assignment_changed")) return `assigned to ${detail.assignee_id}`;
  if (type.endsWith("ticket.group_assignment_changed")) return `routed to ${detail.group_id}`;
  return type.split(":").pop() || "event";
}

// ── Agent event logging ─────────────────────────────────────────────

function logAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "message_end":
      if (event.message.role === "assistant") {
        for (const block of (event.message as AssistantMessage).content) {
          if (block.type === "text" && block.text) {
            log.info({ text: block.text.slice(0, 500) }, "agent reasoning");
          }
        }
      }
      break;
    case "tool_execution_start":
      log.info({ tool: event.toolName, args: event.args }, "tool call");
      break;
    case "tool_execution_end": {
      const text = event.result?.content
        ?.filter((b: { type: string }): b is { type: "text"; text: string } => b.type === "text")
        .map((b: { type: "text"; text: string }) => b.text)
        .join("\n") ?? "";
      log.info(
        { tool: event.toolName, isError: event.isError, output: text.slice(0, 500) },
        "tool result",
      );
      break;
    }
  }
}

// ── Keyboard-gated progression ──────────────────────────────────────
// Each → press resolves one gate. Presses that arrive while the agent
// is still working are queued so rapid tapping doesn't drop events.

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

// ── SSE stream ──────────────────────────────────────────────────────

async function ticketStream(): Promise<Response> {
  const operatorBase = await Bun.file(OPERATOR_PROMPT_PATH).text();
  const systemPrompt = `${operatorBase}

## Reference Data

- SOPs: \`${POLICY_PATH}\` — JSONL file with standard operating procedures (10 policies)
`;

  // Shared SSE send — set once the stream starts, used by agent subscriptions.
  let send: (data: Record<string, unknown>) => void = () => {};

  const { handler, clear } = createSessionHandler(
    () => {
      const created = createAgent({
        systemPrompt,
        model: "claude-sonnet-4-6",
        tools: [],
        thinkingLevel: "high",
      });
      created.agent.subscribe(logAgentEvent);
      // Forward agent lifecycle events to SSE
      created.agent.subscribe((e: AgentEvent) => {
        if (e.type === "message_update") {
          const me = e.assistantMessageEvent as { type: string; delta?: string };
          if (me.type === "thinking_delta" && me.delta) {
            send({ type: "thinking_delta", text: me.delta });
          }
        }
        if (e.type === "tool_execution_start") {
          send({ type: "tool_start", tool: e.toolName, args: e.args });
        }
        if (e.type === "message_end" && e.message.role === "assistant") {
          const text = ((e.message as AssistantMessage).content)
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) send({ type: "agent_response", text });
        }
      });
      return created;
    },
  );
  const lane = createLane(handler);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5_000);

      const announced = new Set<string>();

      mkdirSync(TRACES_DIR, { recursive: true });
      const traceWriter = Bun.file(join(TRACES_DIR, `demo-${Date.now()}.jsonl`)).writer();

      log.info({ tickets: demoEventsByTicket.length }, "stream started");

      try {
        for (const ticketEvents of demoEventsByTicket) {
          const ticketId = String(ticketEvents[0].detail.id);
          const subject = String(ticketEvents[0].detail.subject ?? "");

          for (const event of ticketEvents) {
            // ── Gate: wait for → press ──────────────────────────────
            await waitForNext();

            // Announce ticket on first event
            if (!announced.has(ticketId)) {
              announced.add(ticketId);
              send({ type: "ticket", id: ticketId, subject });
              log.debug({ ticketId, subject }, "ticket announced");
            }

            // Awake
            send({
              type: "event",
              ticketId,
              label: makeEventLabel(event),
            });

            // Work: agent processes (thinking_delta, tool_start, agent_response stream via subscription)
            await startTraceSink({ workItemId: ticketId, write: (line) => traceWriter.write(line) }, () =>
              lane.enqueue(ticketId, event),
            );
          }
        }

        log.info("stream completed");
        send({ type: "done" });
      } catch (err) {
        log.error({ err }, "stream failed");
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepalive);
        traceWriter.end();
        clear();
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
  port: Number(process.env.PORT || 3001),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/stream") {
      log.info("SSE stream requested");
      return ticketStream();
    }

    if (url.pathname === "/api/next" && req.method === "POST") {
      signalNext();
      return new Response("ok");
    }

    // Static file serving
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));

    if (await file.exists()) {
      return new Response(file);
    }

    log.warn({ path: url.pathname }, "not found");
    return new Response("Not found", { status: 404 });
  },
});

log.info({ port: server.port }, "demo server listening");
