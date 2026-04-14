import { join } from "path";

// Bun auto-loads .env from the nearest package.json — which is this spike's.
// ANTHROPIC_API_KEY (and possibly AGENT_ID/ENVIRONMENT_ID) live in the project root.
const rootEnvText = await Bun.file(join(import.meta.dir, "..", "..", ".env")).text().catch(() => "");
for (const line of rootEnvText.split("\n")) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// ── API client ──────────────────────────────────────────────────────

export interface SpikeEnv {
  AGENT_ID: string;
  ENVIRONMENT_ID: string;
}

export function loadSpikeEnv(): SpikeEnv {
  const AGENT_ID = process.env.AGENT_ID;
  const ENVIRONMENT_ID = process.env.ENVIRONMENT_ID;
  if (!AGENT_ID || !ENVIRONMENT_ID) {
    throw new Error("Missing AGENT_ID or ENVIRONMENT_ID in .env — run setup.ts first");
  }
  return { AGENT_ID, ENVIRONMENT_ID };
}

const BASE = "https://api.anthropic.com/v1";

const HEADERS = {
  "x-api-key": process.env.ANTHROPIC_API_KEY!,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: HEADERS,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

export function apiStream(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { ...HEADERS, Accept: "text/event-stream" },
  });
}

// ── SSE parsing ─────────────────────────────────────────────────────

export interface SSEEvent {
  type: string;
  content?: { type: string; text: string }[];
  name?: string;
  input?: unknown;
}

export async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as SSEEvent;
      } catch {
        // skip malformed frames
      }
    }
  }
}

// ── Zendesk domain ──────────────────────────────────────────────────

export type ZenEvent = {
  type: string;
  detail: Record<string, unknown>;
  [key: string]: unknown;
};

export function parseJsonl<T>(text: string): T[] {
  return text.trim().split("\n").map((line) => JSON.parse(line) as T);
}

export const DEMO_TICKET_IDS = new Set(["4800019", "4800027", "4800094", "4800099"]);

export const ALLOWED_EVENT_TYPES = new Set([
  "zen:event-type:ticket.created",
  "zen:event-type:ticket.group_assignment_changed",
  "zen:event-type:ticket.agent_assignment_changed",
  "zen:event-type:ticket.status_changed",
]);

/** Clean baseline (good CSAT) → progressively complex failures. */
export const DEMO_TICKET_ORDER = ["4800019", "4800027", "4800094", "4800099"];

export function makeEventLabel(event: ZenEvent): string {
  const type = event.type;
  const detail = event.detail;
  if (type.endsWith("ticket.created")) return "ticket created";
  if (type.endsWith("ticket.status_changed")) return `status → ${String(detail.status || "").toLowerCase()}`;
  if (type.endsWith("ticket.agent_assignment_changed")) return `assigned to ${detail.assignee_id}`;
  if (type.endsWith("ticket.group_assignment_changed")) return `routed to ${detail.group_id}`;
  return type.split(":").pop() || "event";
}
