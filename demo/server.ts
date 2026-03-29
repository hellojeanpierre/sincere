import { join } from "path";
import { createAgent } from "../src/agent.ts";
import { execTool } from "../src/tools/exec.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const DATA_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_tickets.jsonl");
const PROMPT_PATH = join(import.meta.dir, "../src/operator.md");
const STATIC_DIR = import.meta.dir;

// Load ticket data at startup
const ticketLines = (await Bun.file(DATA_PATH).text()).trim().split("\n");
const tickets = ticketLines.map((line) => JSON.parse(line));
console.log(`Loaded ${tickets.length} tickets from smoke_tickets.jsonl`);

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

function investigateStream(): Response {
  const agent = createAgent({
    promptPath: PROMPT_PATH,
    model: "claude-sonnet-4-6",
    tools: [execTool],
    thinkingLevel: "high",
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", ticketCount: tickets.length });

      const unsub = agent.subscribe((e) => {
        if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
          send({ type: "reasoning_delta", text: e.assistantMessageEvent.delta });
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
        const ticketSummary = JSON.stringify(tickets, null, 2);
        await agent.prompt(
          `Investigate the following ${tickets.length} support tickets and identify root causes for low resolution rates.\n\n${ticketSummary}`,
        );
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        unsub();
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
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (req.method === "POST" && url.pathname === "/api/investigate") {
      try {
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
