import { join } from "path";
import { mkdirSync } from "node:fs";
import { createAgent, createSessionHandler, loadSystemPrompt } from "../src/agent.ts";
import { createLane } from "../src/lane.ts";
import { subscribeTrace } from "../src/lib/trace.ts";
import { startTraceSink } from "../src/lib/logger.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const DATA_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_tickets.jsonl");
const OPERATOR_PROMPT_PATH = join(import.meta.dir, "../src/operator.md");
const OBSERVER_PROMPT_PATH = join(import.meta.dir, "../src/observer.md");
const SAMPLE_FINDINGS_PATH = join(import.meta.dir, "sample_findings.txt");
const EVENTS_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_events.jsonl");
const TRACES_DIR = join(import.meta.dir, "../data/traces");
const STATIC_DIR = import.meta.dir;

// Count tickets at startup (UI needs the count, agent reads the file itself)
const ticketCount = (await Bun.file(DATA_PATH).text()).trim().split("\n").length;

// Load and filter Zendesk events for the observer stream.
const RELEVANT_TYPES = new Set([
  "zen:event-type:ticket.created",
  "zen:event-type:ticket.status_changed",
  "zen:event-type:ticket.agent_assignment_changed",
  "zen:event-type:ticket.group_assignment_changed",
]);
const OBSERVE_TICKET_IDS = [
  "4800003", "4800094", "4800060", "4800031", 
  "4800072", "4800063", "4800045", "4800020",
];
const OBSERVE_TICKET_SET = new Set(OBSERVE_TICKET_IDS);

const smokeEvents: { line: string; ticketId: string; subject: string }[] = [];
{
  // Index all matching events by ticket ID, then emit in the hardcoded order.
  const byTicket = new Map<string, { line: string; ticketId: string; subject: string }[]>();
  for (const line of (await Bun.file(EVENTS_PATH).text()).trim().split("\n")) {
    const evt = JSON.parse(line);
    if (!RELEVANT_TYPES.has(evt.type)) continue;
    const ticketId = String(evt.detail.id);
    if (!OBSERVE_TICKET_SET.has(ticketId)) continue;
    if (!byTicket.has(ticketId)) byTicket.set(ticketId, []);
    byTicket.get(ticketId)!.push({ line, ticketId, subject: evt.detail.subject });
  }
  for (const id of OBSERVE_TICKET_IDS) {
    const events = byTicket.get(id);
    if (events) smokeEvents.push(...events);
  }
}

const FAKE_OBSERVER_OUTPUT = [
  { delay: 550, event: { type: "ticket", id: "TK-4901", subject: "Can't access account after email change" } },
  { delay: 350, event: { type: "event_reasoning", ticketId: "TK-4901", label: "ticket created", reasoning: "Account access issue after email change. Reviewing for known patterns." } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4901", label: "assigned to agent_014", reasoning: "Standard triage assignment. No root cause signals in the ticket description." } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4901", label: "status → open", reasoning: "Agent began work. Cache clearing suggestion is a generic first step, appropriate here." } },
  { delay: 200, event: { type: "verdict", ticketId: "TK-4901", match: false } },

  { delay: 420, event: { type: "ticket", id: "TK-4902", subject: "Invoice shows wrong billing amount" } },
  { delay: 350, event: { type: "event_reasoning", ticketId: "TK-4902", label: "ticket created", reasoning: "Billing discrepancy report. Checking against known billing root causes." } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4902", label: "assigned to agent_017", reasoning: "Routed to billing team. Agent is checking billing history — standard procedure." } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4902", label: "status → solved", reasoning: "pass. Plan mismatch was a display issue resolved by agent. No monitored root cause." } },
  { delay: 200, event: { type: "verdict", ticketId: "TK-4902", match: false } },

  { delay: 420, event: { type: "ticket", id: "TK-4903", subject: "Password reset not working — stuck on confirmation step" } },
  { delay: 350, event: { type: "event_reasoning", ticketId: "TK-4903", label: "ticket created", reasoning: "Password reset failure with session expiration. Early signals of token invalidation pattern." } },
  { delay: 420, event: { type: "event_reasoning", ticketId: "TK-4903", label: "assigned to agent_031", reasoning: "Agent applied generic reset macro without investigating session state — known failure mode for monitored root cause." } },
  { delay: 420, event: { type: "event_reasoning", ticketId: "TK-4903", label: "status → solved", reasoning: "hold — session token invalidation following reset flow. Agent_031 bypassed session investigation. Confidence: 91%." } },
  { delay: 200, event: { type: "verdict", ticketId: "TK-4903", match: true,
    reasoning: "Ticket describes being locked out immediately after completing a password reset. Matches monitored root cause: session token invalidation following reset flow. Agent_031 applied the generic reset macro without investigating the session state. Confidence: 91%.",
    action: "Routed to Escalation Desk" } },

  { delay: 420, event: { type: "ticket", id: "TK-4904", subject: "How do I export my billing history?" } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4904", label: "ticket created", reasoning: "Self-service question about billing export. No root cause pattern expected." } },
  { delay: 200, event: { type: "event_reasoning", ticketId: "TK-4904", label: "status → solved", reasoning: "pass. Agent directed user to Settings > Billing > Export. Straightforward." } },
  { delay: 140, event: { type: "verdict", ticketId: "TK-4904", match: false } },

  { delay: 420, event: { type: "ticket", id: "TK-4905", subject: "API rate limit — need higher quota" } },
  { delay: 350, event: { type: "event_reasoning", ticketId: "TK-4905", label: "ticket created", reasoning: "Rate limit increase request on enterprise plan. Checking against known patterns." } },
  { delay: 280, event: { type: "event_reasoning", ticketId: "TK-4905", label: "assigned to agent_008", reasoning: "Routed to API team. Quota increase is standard, no root cause match." } },
  { delay: 200, event: { type: "event_reasoning", ticketId: "TK-4905", label: "status → solved", reasoning: "pass. Agent submitted quota increase request. Standard operational task." } },
  { delay: 140, event: { type: "verdict", ticketId: "TK-4905", match: false } },
];

const FAKE_TICKETS_JSONL = [
  { id: "TK-4901", subject: "Can't access account after email change", messages: [{ role: "customer", text: "I changed my email and now I'm locked out." }, { role: "agent", text: "Please try clearing your cache." }] },
  { id: "TK-4902", subject: "Invoice shows wrong billing amount", messages: [{ role: "customer", text: "My invoice says $200 but I only signed up for the $50 plan." }, { role: "agent", text: "Let me check your billing history." }] },
  { id: "TK-4903", subject: "Password reset not working — stuck on confirmation step", messages: [{ role: "customer", text: "I reset my password but when I try to log in it says session expired." }, { role: "agent", text: "Try the password reset link again." }] },
  { id: "TK-4904", subject: "How do I export my billing history?", messages: [{ role: "customer", text: "Where do I download invoices?" }, { role: "agent", text: "Go to Settings > Billing > Export." }] },
  { id: "TK-4905", subject: "API rate limit — need higher quota", messages: [{ role: "customer", text: "We're hitting the 1000 req/min limit on our enterprise plan." }, { role: "agent", text: "I'll submit a quota increase request." }] },
];

function skipStream(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", ticketCount });

      try {
        const text = await Bun.file(SAMPLE_FINDINGS_PATH).text();
        send({ type: "reasoning", text });
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
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

function investigateStream(): Response {
  const { agent, dispose } = createAgent({
    promptPath: OPERATOR_PROMPT_PATH,
    model: "claude-sonnet-4-6",
    thinkingLevel: "high",
  });

  const unsubTrace = subscribeTrace(agent, "demo");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", ticketCount });

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5000);

      const unsub = agent.subscribe((e) => {
        if (e.type === "message_update") {
          if (e.assistantMessageEvent.type === "text_delta") {
            send({ type: "reasoning_delta", text: e.assistantMessageEvent.delta });
          }
          if (e.assistantMessageEvent.type === "thinking_delta") {
            send({ type: "thinking_delta", text: e.assistantMessageEvent.delta });
          }
        }
        if (e.type === "tool_execution_start") {
          send({ type: "tool_start", tool: e.toolName, args: e.args });
        }
        if (e.type === "message_end" && "role" in e.message && e.message.role === "assistant") {
          const msg = e.message as AssistantMessage;
          for (const block of msg.content) {
            if (block.type === "text") {
              send({ type: "reasoning", text: block.text });
            }
          }
        }
      });

      try {
        await agent.prompt(
          `Available data (paths relative to project root):\n- data/pintest-v2/smoke-tickets/smoke_tickets.jsonl — ticket snapshots\n- data/pintest-v2/smoke-tickets/smoke_events.jsonl — Zendesk event audit trail\n- data/pintest-v2/smoke-tickets/policy.jsonl — standard operating procedures`,
        );
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepalive);
        unsub();
        unsubTrace();
        await dispose();
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

function skipObserveStream(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      for (const step of FAKE_OBSERVER_OUTPUT) {
        await new Promise((r) => setTimeout(r, step.delay));
        send(step.event);
      }
      send({ type: "done" });
      controller.close();
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

function makeEventLabel(line: string): string {
  try {
    const evt = JSON.parse(line);
    const type = evt.type as string;
    const detail = evt.detail;
    if (type.endsWith("ticket.created")) return "ticket created";
    if (type.endsWith("ticket.status_changed")) return `status → ${(detail.status || "").toLowerCase()}`;
    if (type.endsWith("ticket.agent_assignment_changed")) return `assigned to agent_${detail.assignee_id}`;
    if (type.endsWith("ticket.group_assignment_changed")) return `routed to group_${detail.group_id}`;
    return type.split(":").pop() || "event";
  } catch {
    return "event";
  }
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

function parseVerdict(
  ticketId: string,
  messages: AgentMessage[] | undefined,
): { ticketId: string; match: boolean; reasoning?: string } {
  if (!messages) return { ticketId, match: false };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    // The observer wraps JSON in a markdown code block with surrounding prose.
    // Extract the JSON from the code block before parsing.
    const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    const jsonCandidate = codeBlockMatch ? codeBlockMatch[1].trim() : text;
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (typeof parsed.state === "string" && parsed.state.toLowerCase() === "hold") {
        return { ticketId, match: true, reasoning: text };
      }
      return { ticketId, match: false };
    } catch {
      // fallback: legacy regex for non-JSON responses
      if (/^\*{0,2}hold\b/im.test(text)) {
        return { ticketId, match: true, reasoning: text };
      }
      return { ticketId, match: false };
    }
  }
  return { ticketId, match: false };
}

// Redact ticket IDs (e.g. 4800094) from root cause text so the observer
// cannot recognise a ticket because its ID appears in root cause text,
// rather than matching on the described behavioral pattern.
function redactTicketIds(text: string): string {
  return text.replace(/\b48000\d{2}\b/g, "[ticket]");
}

function observeStream(findingText: string): Response {
  // graph.json is empty, so {{rootCauses}} resolves to blank — the observer
  // sees an empty ## Root causes section. Inject the finding there so the
  // observer recognises it as the root cause it should match against.
  const basePrompt = loadSystemPrompt(OBSERVER_PROMPT_PATH);
  const redacted = redactTicketIds(findingText);
  const systemPrompt = basePrompt.replace(
    /## Root causes\n\n*/,
    `## Root causes\n\n- ${redacted}\n\n`,
  );

  const { handler, sessions, clear } = createSessionHandler(
    () => createAgent({
      systemPrompt,
      model: "claude-haiku-4-5-20251001",
      tools: [],
      thinkingLevel: "off",
    }),
  );
  const lane = createLane(handler);

  // Pre-compute last event index per ticket for verdict timing.
  const lastEventIdx = new Map<string, number>();
  for (let i = 0; i < smokeEvents.length; i++) {
    lastEventIdx.set(smokeEvents[i].ticketId, i);
  }

  mkdirSync(TRACES_DIR, { recursive: true });
  const traceWriter = Bun.file(join(TRACES_DIR, `observer-${Date.now()}.jsonl`)).writer();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5000);

      const announced = new Set<string>();

      try {
        for (let i = 0; i < smokeEvents.length; i++) {
          const { line, ticketId, subject } = smokeEvents[i];

          await startTraceSink({ workItemId: ticketId, write: (line) => traceWriter.write(line) }, async () => {
            if (!announced.has(ticketId)) {
              announced.add(ticketId);
              send({ type: "ticket", id: ticketId, subject });
            }

            // lane.enqueue() returns a promise that resolves after handler()
            // completes (not just after queuing) — sessions() reads are safe.
            await lane.enqueue(ticketId, line);

            // Emit per-event reasoning so the browser can show live observer thinking.
            const reasoning = extractLastReasoning(sessions(ticketId) ?? []);
            if (reasoning) {
              send({ type: "event_reasoning", ticketId, label: makeEventLabel(line), reasoning });
            }

            if (lastEventIdx.get(ticketId) === i) {
              send({ type: "verdict", ...parseVerdict(ticketId, sessions(ticketId)) });
            }
          });
        }

        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepalive);
        clear();
        traceWriter.end();
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

const server = Bun.serve({
  port: Number(process.env.PORT || 3001),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    // Unified agent endpoint
    if (req.method === "POST" && url.pathname === "/api/agent") {
      try {
        const body = await req.json() as { type: string; finding?: string; skip?: boolean };

        if (body.type === "operator") {
          return body.skip ? skipStream() : investigateStream();
        }

        if (body.type === "observer") {
          if (body.skip) return skipObserveStream();
          if (!body.finding) {
            return Response.json({ error: "finding text required for observer" }, { status: 400 });
          }
          return observeStream(body.finding);
        }

        return Response.json({ error: `unknown agent type: ${body.type}` }, { status: 400 });
      } catch (err) {
        console.error("agent endpoint failed:", err);
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // Static file serving
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on http://localhost:${server.port}`);
