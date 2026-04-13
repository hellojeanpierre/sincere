import { describe, test, expect, afterAll } from "bun:test";
import { resolve } from "path";
import { createAgent } from "./agent.ts";
import { intake } from "./intake.ts";

const EVENTS_PATH = "data/pintest-v2/smoke-tickets/smoke_events.jsonl";

async function loadEvent(id: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(EVENTS_PATH).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line);
    if (evt.id === id) return evt;
  }
  throw new Error(`Event ${id} not found in ${EVENTS_PATH}`);
}

describe("intake", () => {
  const { agent, dispose } = createAgent({
    promptPath: resolve(import.meta.dirname, "analyst.md"),
    model: process.env.MODEL || "claude-sonnet-4-6",
    thinkingLevel: "high",
  });
  afterAll(() => dispose());

  test(
    "processes ticket.created event (evt-00000353)",
    async () => {
      const event = await loadEvent("evt-00000353");
      expect(event.type).toBe("zen:event-type:ticket.created");

      const response = await intake(agent, event);
      expect(response.length).toBeGreaterThan(0);
    },
    { timeout: 120_000 },
  );

  test(
    "processes ticket.status_changed event (evt-00000358)",
    async () => {
      const event = await loadEvent("evt-00000358");
      expect(event.type).toBe("zen:event-type:ticket.status_changed");

      const response = await intake(agent, event);
      expect(response.length).toBeGreaterThan(0);
    },
    { timeout: 120_000 },
  );
});
