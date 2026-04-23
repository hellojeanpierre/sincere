import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";

type StreamEvent = Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;

const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";
const ENVIRONMENT_ID = "env_01BeAimUGVuvGamH6fgfiUTa";
const TEST_TICKET_ID = "4800019";

const DATA_DIR = join(import.meta.dir, "..", "data", "pintest-v2", "smoke-tickets");
const POLICY_PATH = join(DATA_DIR, "policy.jsonl");
const EVENTS_PATH = join(DATA_DIR, "smoke_events.jsonl");

const client = new Anthropic();

const blob = Bun.file(POLICY_PATH);
const uploaded = await client.beta.files.upload({
  file: new File([await blob.arrayBuffer()], "policy.jsonl", { type: blob.type }),
});
const POLICY_FILE_ID = uploaded.id;
console.log(`Uploaded policy.jsonl: ${POLICY_FILE_ID}`);

let currentSessionId: string | null = null;

async function runTurn(sessionId: string, content: Array<{ type: "text"; text: string }>): Promise<string> {
  const stream = await client.beta.sessions.events.stream(sessionId);

  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content }],
  });

  const texts: string[] = [];
  for await (const event of stream as AsyncIterable<StreamEvent>) {
    console.log(`[${sessionId}] event: ${event.type}`);

    if (event.type === "agent.message") {
      for (const block of (event as { content: Array<{ type: string; text?: string }> }).content) {
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }

    if (event.type === "session.error") {
      const e = event as { error: { message: string } };
      throw new Error(`session.error: ${e.error.message}`);
    }

    if (event.type === "session.status_idle") {
      const stopType = event.stop_reason.type;
      if (stopType === "end_turn") break;
      throw new Error(`Unexpected stop_reason: ${stopType}`);
    }
  }

  return texts.join("\n");
}

async function firstEventForTicket(ticketId: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(EVENTS_PATH).text();
  for (const line of text.trim().split("\n")) {
    const ev = JSON.parse(line) as { detail?: { id?: unknown } };
    if (String(ev.detail?.id) === ticketId) return ev as Record<string, unknown>;
  }
  throw new Error(`No events for ticket ${ticketId}`);
}

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/test" && req.method === "POST") {
      try {
        const session = await client.beta.sessions.create({
          agent: AGENT_ID,
          environment_id: ENVIRONMENT_ID,
          resources: [
            { type: "file", file_id: POLICY_FILE_ID, mount_path: "/mnt/session/uploads/policy.jsonl" },
          ],
        });
        console.log(`Session created: ${session.id}`);
        currentSessionId = session.id;

        const response = await runTurn(session.id, [{
          type: "text",
          text: "You are observing a support ticket. Confirm you can access the policy file and are ready to receive events.",
        }]);

        return Response.json({ session_id: session.id, response });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("POST /test error:", err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    if (url.pathname === "/test/event" && req.method === "POST") {
      if (!currentSessionId) {
        return Response.json({ error: "No session. POST /test first." }, { status: 400 });
      }
      try {
        const event = await firstEventForTicket(TEST_TICKET_ID);
        const response = await runTurn(currentSessionId, [{
          type: "text",
          text: JSON.stringify(event, null, 2),
        }]);
        return Response.json({ session_id: currentSessionId, response });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("POST /test/event error:", err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pilot server listening on port ${server.port}`);
