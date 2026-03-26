import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "./gateway.ts";
import type { Server } from "bun";

let server: Server;
let base: string;

beforeAll(() => {
  server = startGateway(0);
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("gateway", () => {
  test("POST ticket.created returns 200 and receives raw body", async () => {
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

    const raw = JSON.stringify(payload);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("GET returns 405", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(405);
  });
});
