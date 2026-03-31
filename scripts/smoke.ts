import { resolve } from "path";
import { createLane } from "../src/lane.ts";
import { startGateway } from "../src/gateway.ts";
import { logger } from "../src/lib/logger.ts";
import { createAgent, createSessionHandler } from "../src/agent.ts";

const FIXTURE = "data/pintest-v2/smoke-tickets/smoke_tickets.jsonl";
const TICKET_LINES = [0, 4]; // tickets 4800013, 4800070

const lines = (await Bun.file(FIXTURE).text()).split("\n").filter(Boolean);
for (const line of lines) {
  if (line.includes('"_ground_truth"')) {
    throw new Error("smoke: fixture contains _ground_truth — agent must not see eval labels");
  }
}
const picked = TICKET_LINES.map((i) => JSON.parse(lines[i]));

// Build two distinct events per ticket: open → solved.
const ticketA_open = JSON.stringify({ ...picked[0], status: "open" });
const ticketA_solved = JSON.stringify({ ...picked[0], status: "solved" });
const ticketB_open = JSON.stringify({ ...picked[1], status: "open" });
const ticketB_solved = JSON.stringify({ ...picked[1], status: "solved" });

// Interleave: A1, B1, A2, B2 — exercises per-workitem serial queueing.
const interleaved = [ticketA_open, ticketB_open, ticketA_solved, ticketB_solved];
const total = interleaved.length;

// Wrap observer handler with a completion latch so we can await all fire-and-forget work.
let remaining = total;
let resolveAll!: () => void;
const allProcessed = new Promise<void>((r) => {
  resolveAll = r;
});

const { handler } = createSessionHandler(() =>
  createAgent({
    promptPath: resolve(import.meta.dirname, "../src/observer.md"),
    model: process.env.MODEL || "claude-haiku-4-5-20251001",
    tools: [],
    thinkingLevel: "off",
  })
);
const lane = createLane(async (body, workItemId) => {
  try {
    await handler(body, workItemId);
  } finally {
    remaining--;
    if (remaining === 0) resolveAll();
  }
});

const server = startGateway(0, lane);
const base = `http://localhost:${server.port}`;

logger.info({ port: server.port }, "smoke: gateway started");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < interleaved.length; i++) {
  if (i > 0) await sleep(2000);
  const body = interleaved[i];
  const parsed = JSON.parse(body);
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  logger.info(
    { ticketId: parsed.id, ticketStatus: parsed.status, http: res.status },
    "smoke: POST response",
  );
}

// Wait for all async observer work spawned by the gateway's fire-and-forget enqueue.
await allProcessed;

logger.info("smoke: done");
server.stop(true);
process.exit(0);
