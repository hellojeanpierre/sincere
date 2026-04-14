import { readFileSync } from "fs";
import { join } from "path";

// Bun auto-loads .env from the nearest package.json — which is this spike's.
// ANTHROPIC_API_KEY lives in the project root .env.
try {
  const text = readFileSync(join(import.meta.dir, "..", "..", ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// ── API client ──────────────────────────────────────────────────────

export const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";
export const ENVIRONMENT_ID = "env_01BeAimUGVuvGamH6fgfiUTa";

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

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: HEADERS,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiUploadFile(filePath: string): Promise<{ id: string }> {
  const file = Bun.file(filePath);
  const formData = new FormData();
  formData.append("file", file, filePath.split("/").pop()!);
  const res = await fetch(`${BASE}/files`, {
    method: "POST",
    headers: {
      "x-api-key": HEADERS["x-api-key"],
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File upload failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{ id: string }>;
}

export async function apiInterrupt(sessionId: string): Promise<void> {
  await apiPost(`/sessions/${sessionId}/events`, {
    events: [{ type: "user.interrupt" }],
  });
}

// ── Session event types ─────────────────────────────────────────────

export type SessionEvent =
  | { type: "agent.custom_tool_use"; id: string; name: string; input: unknown }
  | { type: "agent.message"; content: { type: string; text?: string }[] }
  | { type: "session.status_idle"; stop_reason?: { type: string; event_ids?: string[] } }
  | { type: "session.status_running" }
  | { type: "session.status_terminated" }
  | { type: string; [key: string]: unknown };

// ── SSE streaming ───────────────────────────────────────────────────

export async function apiStream(sessionId: string): Promise<AsyncIterable<SessionEvent>> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, {
    method: "GET",
    headers: { ...HEADERS, "anthropic-beta": "agent-api-2026-03-01", Accept: "text/event-stream" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stream failed: ${res.status} ${res.statusText}: ${text}`);
  }

  async function* events(): AsyncGenerator<SessionEvent> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop()!;
      for (const block of blocks) {
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => (l[5] === " " ? l.slice(6) : l.slice(5)))
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as SessionEvent;
        } catch {
          // skip unparseable SSE frames
        }
      }
    }
  }

  return events();
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
