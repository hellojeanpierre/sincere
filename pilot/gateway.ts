import { join } from "path";
import { initEvents } from "./events";
import { initSession } from "./session";
import { handleZendeskIngest } from "./ingest/zendesk";
import { handleTest, handleTestEvent, handleTestIngest } from "./test";

const DB_PATH = join(import.meta.dir, "data", "events.db");
initEvents(DB_PATH);
console.log(`Opened event store: ${DB_PATH}`);

await initSession();

const allowTestRoutes = process.env.PILOT_ALLOW_TEST_INGEST === "1";
const zendeskSecret = process.env.ZENDESK_WEBHOOK_SECRET;

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST") {
      if (url.pathname === "/ingest/zendesk") return handleZendeskIngest(req, zendeskSecret);

      if (allowTestRoutes) {
        if (url.pathname === "/test") return handleTest();
        if (url.pathname === "/test/event") return handleTestEvent();
        if (url.pathname === "/ingest/test") return handleTestIngest(req);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pilot gateway listening on port ${server.port}`);
