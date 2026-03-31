import { join } from "path";
import { createAgent } from "../src/agent.ts";
import { subscribeTrace } from "../src/lib/trace.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const DATA_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_tickets.jsonl");
const PROMPT_PATH = join(import.meta.dir, "../src/operator.md");
const SAMPLE_FINDINGS_PATH = join(import.meta.dir, "sample_findings.txt");
const STATIC_DIR = import.meta.dir;

// Count tickets at startup (UI needs the count, agent reads the file itself)
const ticketCount = (await Bun.file(DATA_PATH).text()).trim().split("\n").length;

function sseStream(): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Empty SSE stream — close immediately
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
  const agent = createAgent({
    promptPath: PROMPT_PATH,
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

    // API routes
    if (req.method === "POST" && url.pathname === "/api/investigate") {
      try {
        if (url.searchParams.get("skip") === "true") {
          return skipStream();
        }
        return investigateStream();
      } catch (err) {
        console.error("investigate failed:", err);
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }
    if (req.method === "POST" && url.pathname === "/api/observe") {
      return sseStream();
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
