import { join } from "path";
import { createAgent } from "../src/agent.ts";
import { subscribeTrace } from "../src/lib/trace.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const DATA_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_tickets.jsonl");
const OPERATOR_PROMPT_PATH = join(import.meta.dir, "../src/operator.md");
const OBSERVER_PROMPT_PATH = join(import.meta.dir, "../src/observer.md");
const SAMPLE_FINDINGS_PATH = join(import.meta.dir, "sample_findings.txt");
const STATIC_DIR = import.meta.dir;

// Count tickets at startup (UI needs the count, agent reads the file itself)
const ticketCount = (await Bun.file(DATA_PATH).text()).trim().split("\n").length;

const FAKE_OBSERVER_OUTPUT = [
  { delay: 800, event: { type: "ticket", id: "TK-4901", subject: "Can't access account after email change" } },
  { delay: 1400, event: { type: "verdict", ticketId: "TK-4901", match: false } },
  { delay: 2200, event: { type: "ticket", id: "TK-4902", subject: "Invoice shows wrong billing amount" } },
  { delay: 1100, event: { type: "verdict", ticketId: "TK-4902", match: false } },
  { delay: 2800, event: { type: "ticket", id: "TK-4903", subject: "Password reset not working — stuck on confirmation step" } },
  { delay: 1800, event: { type: "verdict", ticketId: "TK-4903", match: true,
    reasoning: "Ticket describes being locked out immediately after completing a password reset. Matches monitored root cause: session token invalidation following reset flow. Agent_031 applied the generic reset macro without investigating the session state. Confidence: 91%.",
    action: "Routed to Escalation Desk" } },
  { delay: 2400, event: { type: "ticket", id: "TK-4904", subject: "How do I export my billing history?" } },
  { delay: 900, event: { type: "verdict", ticketId: "TK-4904", match: false } },
  { delay: 2000, event: { type: "ticket", id: "TK-4905", subject: "API rate limit — need higher quota" } },
  { delay: 1200, event: { type: "verdict", ticketId: "TK-4905", match: false } },
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

function observeStream(findingText: string): Response {
  const { agent, dispose } = createAgent({
    promptPath: OBSERVER_PROMPT_PATH,
    model: "claude-sonnet-4-6",
  });

  const unsubTrace = subscribeTrace(agent, "demo-observer");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5000);

      // Feed tickets one at a time and stream verdicts back
      const unsub = agent.subscribe((e) => {
        if (e.type === "message_end" && "role" in e.message && e.message.role === "assistant") {
          const msg = e.message as AssistantMessage;
          for (const block of msg.content) {
            if (block.type === "text") {
              send({ type: "reasoning_delta", text: block.text });
            }
          }
        }
      });

      try {
        // Prime the observer with the root cause pattern
        await agent.prompt(
          `Monitor incoming cases for this root cause pattern:\n\n${findingText}`,
        );

        // Feed each fake ticket
        for (const ticket of FAKE_TICKETS_JSONL) {
          send({ type: "ticket", id: ticket.id, subject: ticket.subject });
          const ticketText = `New ticket ${ticket.id}: "${ticket.subject}"\n\n` +
            ticket.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
          await agent.prompt(ticketText);
        }

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
