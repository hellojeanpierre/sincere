import { createHmac, timingSafeEqual } from "crypto";
import type { Event } from "../events";
import { insertEvent } from "../events";
import type { SessionManager } from "../session";

const SOURCE = "zendesk";

// Freshness window for the HMAC timestamp. Tradeoff: Zendesk re-signs each
// delivery attempt with a fresh timestamp, so legitimate retries arrive with
// a current signature and pass this check. A long-running outage on our side
// that exceeds Zendesk's retry schedule (hours) will cause those retries to
// be dropped — we'd rather re-fetch missed events from Zendesk's API than
// accept signatures older than 5 minutes (replay protection).
const FRESHNESS_WINDOW_MS = 5 * 60_000;

export function verifySignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() - tsNum * 1000) > FRESHNESS_WINDOW_MS) return false;

  const expected = createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

// Expected payload: Zendesk "Events API" (v2) webhook body — the shape used
// by ticket.* event-type triggers, distinct from legacy v1 trigger-based
// webhooks and from user-customized trigger payloads. Required top-level
// fields: `id` (e.g. "evt-00000353", used as the dedup key), `type`
// (e.g. "zen:event-type:ticket.created"). Optional: `time` (ISO-8601),
// `detail.id` (ticket id, used as subject). Raw body is stored verbatim.
export function parseZendeskEvent(rawBody: string, receivedAt: number): Event {
  const parsed = JSON.parse(rawBody) as {
    id?: unknown;
    type?: unknown;
    time?: unknown;
    detail?: { id?: unknown };
  };

  const sourceEventId = typeof parsed.id === "string" ? parsed.id : null;
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!sourceEventId) throw new Error("Zendesk event missing top-level `id`");
  if (!type) throw new Error("Zendesk event missing top-level `type`");

  const sourceTime = typeof parsed.time === "string" ? parsed.time : null;
  const detailId = parsed.detail?.id;
  const subjectId =
    typeof detailId === "string" || typeof detailId === "number" ? String(detailId) : null;

  return {
    source: SOURCE,
    sourceEventId,
    type,
    subjectId,
    sourceTime,
    receivedAt,
    payload: parsed,
  };
}

export async function handleZendeskIngest(
  req: Request,
  secret: string | undefined,
  sessionManager: SessionManager,
): Promise<Response> {
  if (!secret) {
    console.error("[ingest] /ingest/zendesk called but ZENDESK_WEBHOOK_SECRET is unset");
    return Response.json({ error: "server not configured" }, { status: 500 });
  }

  const signature = req.headers.get("x-zendesk-webhook-signature");
  const timestamp = req.headers.get("x-zendesk-webhook-signature-timestamp");
  if (!signature || !timestamp) {
    console.warn("[ingest] /ingest/zendesk missing signature headers");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawBody = await req.text();

  if (!verifySignature(rawBody, timestamp, signature, secret)) {
    console.warn("[ingest] /ingest/zendesk signature/timestamp check failed");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let event: Event;
  try {
    event = parseZendeskEvent(rawBody, Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ingest] /ingest/zendesk parse error:", message);
    return Response.json({ error: message }, { status: 400 });
  }

  const result = insertEvent(event);
  console.log(`[ingest] zendesk id=${event.sourceEventId} subject=${event.subjectId ?? "-"} -> ${result}`);

  if (result === "inserted") sessionManager.enqueueEvent(event);
  return Response.json({
    result,
    source_event_id: event.sourceEventId,
    queued: result === "inserted",
  });
}
