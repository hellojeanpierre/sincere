import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { startGateway } from "./gateway.ts";
import { createLane } from "./lane.ts";
import { createSessionHandler } from "./agent.ts";
import type { Server } from "bun";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("gateway", () => {
  let server: Server;
  let base: string;
  const received: { workItemId: string; event: Record<string, unknown> }[] = [];

  beforeEach(() => {
    received.length = 0;
    server?.stop(true);
    const lane = createLane<Record<string, unknown>>(async (event, workItemId) => {
      received.push({ workItemId, event });
    });
    server = startGateway(0, lane);
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("POST ticket.created returns 200 and receives parsed event", async () => {
    const payload = {
      id: "evt-test-001",
      type: "zen:event-type:ticket.created",
      ticket: {
        id: 12345,
        subject: "Help with billing",
        status: "new",
        priority: "normal",
        requester: { name: "Jane Doe", email: "jane@example.com" },
      },
      timestamp: "2026-03-26T10:00:00Z",
    };

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("POST with invalid JSON returns 200 and does not crash", async () => {
    const res = await fetch(base, {
      method: "POST",
      body: "not json at all",
    });
    expect(res.status).toBe(200);
  });

  test("GET returns 405", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(405);
  });

  test("duplicate webhook (same ticket + timestamp) is skipped", async () => {
    const payload = {
      ticket: { id: 999 },
      timestamp: "2026-04-01T12:00:00Z",
    };
    const body = JSON.stringify(payload);

    await fetch(base, { method: "POST", body });
    await fetch(base, { method: "POST", body });
    await delay(50);

    expect(received).toHaveLength(1);
    expect(received[0].workItemId).toBe("999");
  });

  test("same ticket with different timestamps both processed", async () => {
    const body1 = JSON.stringify({
      ticket: { id: 888 },
      timestamp: "2026-04-01T12:00:00Z",
    });
    const body2 = JSON.stringify({
      ticket: { id: 888 },
      timestamp: "2026-04-01T12:05:00Z",
    });

    await fetch(base, { method: "POST", body: body1 });
    await fetch(base, { method: "POST", body: body2 });
    await delay(50);

    expect(received).toHaveLength(2);
  });

  test("payload without timestamp skips dedup", async () => {
    const body = JSON.stringify({ ticket: { id: 777 } });

    await fetch(base, { method: "POST", body });
    await fetch(base, { method: "POST", body });
    await delay(50);

    expect(received).toHaveLength(2);
  });

  test("malformed payload returns 200 and handler is not called", async () => {
    const res = await fetch(base, {
      method: "POST",
      body: "{bad json!!!",
    });

    expect(res.status).toBe(200);
    await delay(50);
    expect(received).toHaveLength(0);
  });
});

describe("gateway timeout", () => {
  test("slow handler times out and lane unblocks for next enqueue", async () => {
    let callCount = 0;

    const { handler } = createSessionHandler(
      () => {
        callCount++;
        const listeners = new Set<(e: any) => void>();
        let abortController: AbortController | undefined;

        return {
          agent: {
            replaceMessages() {},
            subscribe(fn: (e: any) => void) {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
            async prompt() {
              abortController = new AbortController();
              return new Promise<void>((_resolve, reject) => {
                abortController!.signal.addEventListener("abort", () => {
                  reject(new Error("aborted"));
                });
              });
            },
            abort() {
              abortController?.abort();
            },
            state: { messages: [] },
          } as any,
          dispose: async () => {},
        };
      },
      50, // 50ms timeout for test speed
    );

    const lane = createLane<Record<string, unknown>>(handler);

    const p1 = lane.enqueue("wk-slow", { ticket: { id: 1 } });
    await p1;

    const p2 = lane.enqueue("wk-slow", { ticket: { id: 1 } });
    await p2;

    expect(callCount).toBe(2);
  });
});
