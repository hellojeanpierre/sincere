import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { createAgent } from "./agent.ts";
import { execTool } from "./tools/exec.ts";
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
  const agent = createAgent({
    promptPath: resolve(import.meta.dirname, "operator.md"),
    model: process.env.MODEL || "claude-sonnet-4-6",
    tools: [execTool],
    thinkingLevel: "high",
  });

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
