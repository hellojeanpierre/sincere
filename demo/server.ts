import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";

type StreamEvent = Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;

const client = new Anthropic();

const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";
const ENVIRONMENT_ID = "env_01BeAimUGVuvGamH6fgfiUTa";

// ── Proof of life ──────────────────────────────────────────────────
// SSE forwarding added in Increment 5.

async function proofOfLife(): Promise<Response> {
  // TODO: archive session on shutdown
  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
  });
  console.log(`Session created: ${session.id}`);

  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: "Hello, confirm you're alive." }],
    }],
  });
  console.log("Sent user.message");

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

    if (url.pathname === "/api/stream") return proofOfLife();

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on port ${server.port}`);
