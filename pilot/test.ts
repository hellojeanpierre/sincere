import { join } from "path";
import type { Event } from "./events";
import { insertEvent } from "./events";
import type { SessionManager } from "./session";
import { parseZendeskEvent } from "./ingest/zendesk";

const TEST_SESSION_KEY = "__test__";
const TEST_TICKET_ID = "4800019";
const EVENTS_PATH = join(
  import.meta.dir,
  "..",
  "data",
  "pintest-v2",
  "smoke-tickets",
  "smoke_events.jsonl",
);

async function firstEventForTicket(ticketId: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(EVENTS_PATH).text();
  for (const line of text.trim().split("\n")) {
    const ev = JSON.parse(line) as { detail?: { id?: unknown } };
    if (String(ev.detail?.id) === ticketId) return ev as Record<string, unknown>;
  }
  throw new Error(`No events for ticket ${ticketId}`);
}

export async function handleTest(sessionManager: SessionManager): Promise<Response> {
  try {
    const sessionId = await sessionManager.createSession(TEST_SESSION_KEY);
    const { text } = await sessionManager.runTurn(sessionId, [{
      type: "text",
      text: "You are observing a support ticket. Confirm you can access the policy file and are ready to receive events.",
    }]);
    return Response.json({ session_id: sessionId, response: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("POST /test error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleTestEvent(sessionManager: SessionManager): Promise<Response> {
  const sessionId = sessionManager.getSession(TEST_SESSION_KEY);
  if (!sessionId) {
    return Response.json({ error: "No session. POST /test first." }, { status: 400 });
  }
  try {
    const event = await firstEventForTicket(TEST_TICKET_ID);
    const { text } = await sessionManager.runTurn(sessionId, [{
      type: "text",
      text: JSON.stringify(event, null, 2),
    }]);
    return Response.json({ session_id: sessionId, response: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("POST /test/event error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleTestIngest(req: Request, sessionManager: SessionManager): Promise<Response> {
  const rawBody = await req.text();

  let event: Event;
  try {
    event = parseZendeskEvent(rawBody, Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ingest] /ingest/test parse error:", message);
    return Response.json({ error: message }, { status: 400 });
  }

  const result = insertEvent(event);
  console.log(`[ingest] test id=${event.sourceEventId} subject=${event.subjectId ?? "-"} -> ${result}`);

  if (result === "inserted") sessionManager.enqueueEvent(event);
  return Response.json({
    result,
    source_event_id: event.sourceEventId,
    queued: result === "inserted",
  });
}
