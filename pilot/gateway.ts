import { mkdirSync } from "fs";
import { dirname, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getUnprocessedEvents, initEvents } from "./events";
import { createSessionManager } from "./session";
import { handleZendeskIngest } from "./ingest/zendesk";
import { handleTest, handleTestEvent, handleTestIngest } from "./test";

const DB_PATH = join(import.meta.dir, "data", "events.db");
mkdirSync(dirname(DB_PATH), { recursive: true });
initEvents(DB_PATH);
console.log(`Opened event store: ${DB_PATH}`);

const POLICY_PATH = join(import.meta.dir, "..", "data", "pintest-v2", "smoke-tickets", "policy.jsonl");

const sessionManager = createSessionManager({
  client: new Anthropic(),
  policyPath: POLICY_PATH,
});
await sessionManager.initSession();

const stranded = getUnprocessedEvents();
if (stranded.length > 0) {
  console.log(`Replaying ${stranded.length} unprocessed events`);
  for (const event of stranded) sessionManager.enqueueEvent(event);
}

const allowTestRoutes = process.env.PILOT_ALLOW_TEST_INGEST === "1";
const zendeskSecret = process.env.ZENDESK_WEBHOOK_SECRET;

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST") {
      if (url.pathname === "/ingest/zendesk") return handleZendeskIngest(req, zendeskSecret, sessionManager);

      if (allowTestRoutes) {
        if (url.pathname === "/test") return handleTest(sessionManager);
        if (url.pathname === "/test/event") return handleTestEvent(sessionManager);
        if (url.pathname === "/ingest/test") return handleTestIngest(req, sessionManager);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pilot gateway listening on port ${server.port}`);
