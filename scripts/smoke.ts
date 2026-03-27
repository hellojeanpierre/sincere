import { createLane } from "../src/lane.ts";
import { startGateway } from "../src/gateway.ts";
import { logger } from "../src/lib/logger.ts";
import { createObserver } from "../src/observer.ts";

const FIXTURE = "data/pintest-v2/smoke-tickets/smoke_tickets.jsonl";
const TICKET_LINES = [0, 4]; // tickets 4800013, 4800070

const lines = (await Bun.file(FIXTURE).text()).split("\n").filter(Boolean);
const picked = TICKET_LINES.map((i) => lines[i]);

// Interleave: A, B, A, B — exercises per-workitem serial queueing.
const interleaved = [picked[0], picked[1], picked[0], picked[1]];
const total = interleaved.length;

// Wrap observer handler with a completion latch so we can await all fire-and-forget work.
let remaining = total;
let resolveAll!: () => void;
const allProcessed = new Promise<void>((r) => {
  resolveAll = r;
});

const { handler } = createObserver();
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

for (let i = 0; i < interleaved.length; i++) {
  const body = interleaved[i];
  const { id, status, type, subject } = JSON.parse(body);
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  logger.info(
    { ticketId: id, httpStatus: res.status, type, status, subject, seq: `${i + 1}/${total}` },
    "smoke: POST response",
  );
}

logger.info("smoke: waiting for observer processing");

// Wait for all async observer work spawned by the gateway's fire-and-forget enqueue.
await allProcessed;

logger.info("smoke: done");
server.stop(true);
process.exit(0);
