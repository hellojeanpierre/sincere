import { join } from "path";
import { createAgent, createSessionHandler } from "../src/agent.ts";
import { createLane } from "../src/lane.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ── Constants ───────────────────────────────────────────────────────

const OPERATOR_PROMPT_PATH = join(import.meta.dir, "operator.md");
const STATIC_DIR = import.meta.dir;
const EVENT_DELAY_MS = 2_000;

const DATA_DIR = join(import.meta.dir, "..", "data", "pintest-v2", "smoke-tickets");
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
const demoEvents = allEvents.filter(
  (e) => ALLOWED_EVENT_TYPES.has(e.type) && DEMO_TICKET_IDS.has(String(e.detail.id)),
);

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

function extractLastReasoning(msgs: AgentMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;
    const text = ((msgs[i] as AssistantMessage).content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

// ── SSE stream ──────────────────────────────────────────────────────

async function ticketStream(): Promise<Response> {
  const operatorBase = await Bun.file(OPERATOR_PROMPT_PATH).text();
  const systemPrompt = `${operatorBase}

## Reference Data

- Tickets: \`${TICKETS_PATH}\` — JSONL file with full ticket details (32 tickets)
- SOPs: \`${POLICY_PATH}\` — JSONL file with standard operating procedures (10 policies)
`;

  const { handler, sessions, clear } = createSessionHandler(
    () => createAgent({
      systemPrompt,
      model: "claude-haiku-4-5-20251001",
      tools: [],
      thinkingLevel: "high",
    }),
  );
  const lane = createLane(handler);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5_000);

      const announced = new Set<string>();

      try {
        for (const event of demoEvents) {
          const ticketId = String(event.detail.id);
          const subject = String(event.detail.subject ?? "");

          await new Promise((r) => setTimeout(r, EVENT_DELAY_MS));

          if (!announced.has(ticketId)) {
            announced.add(ticketId);
            send({ type: "ticket", id: ticketId, subject });
          }

          await lane.enqueue(ticketId, event);

          const reasoning = extractLastReasoning(sessions(ticketId) ?? []);
          send({
            type: "event",
            ticketId,
            label: makeEventLabel(event),
            reasoning,
          });
        }

        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepalive);
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
      return ticketStream();
    }

    // Static file serving
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on http://localhost:${server.port}`);
