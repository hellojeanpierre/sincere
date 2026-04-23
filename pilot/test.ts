import { join } from "path";
import type { Event } from "./events";
import { insertEvent, markProcessed } from "./events";
import { createSession, dispatchEvent, getSession, runTurn } from "./session";
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

export async function handleTest(): Promise<Response> {
  try {
    const sessionId = await createSession(TEST_SESSION_KEY);
    const response = await runTurn(sessionId, [{
      type: "text",
      text: "You are observing a support ticket. Confirm you can access the policy file and are ready to receive events.",
    }]);
    return Response.json({ session_id: sessionId, response });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("POST /test error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleTestEvent(): Promise<Response> {
  const sessionId = getSession(TEST_SESSION_KEY);
  if (!sessionId) {
    return Response.json({ error: "No session. POST /test first." }, { status: 400 });
  }
  try {
    const event = await firstEventForTicket(TEST_TICKET_ID);
    const response = await runTurn(sessionId, [{
      type: "text",
      text: JSON.stringify(event, null, 2),
    }]);
    return Response.json({ session_id: sessionId, response });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("POST /test/event error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleTestIngest(req: Request): Promise<Response> {
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

  if (result === "duplicate") {
    return Response.json({ result, source_event_id: event.sourceEventId, dispatched: false });
  }

  try {
    const response = await dispatchEvent(event);
    markProcessed(event.source, event.sourceEventId);
    return Response.json({
      result,
      source_event_id: event.sourceEventId,
      dispatched: true,
      agent_response: response,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] dispatch error for ${event.sourceEventId}:`, message);
    return Response.json({
      result,
      source_event_id: event.sourceEventId,
      dispatched: false,
      dispatch_error: message,
    }, { status: 500 });
  }
}
