import { join } from "path";

const DATA_PATH = join(import.meta.dir, "../data/pintest-v2/smoke-tickets/smoke_tickets.jsonl");
const STATIC_DIR = import.meta.dir;

// Load ticket data at startup
const ticketLines = (await Bun.file(DATA_PATH).text()).trim().split("\n");
const tickets = ticketLines.map((line) => JSON.parse(line));
console.log(`Loaded ${tickets.length} tickets from smoke_tickets.jsonl`);

function sseStream(): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Empty SSE stream — close immediately
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (req.method === "POST" && url.pathname === "/api/investigate") {
      return sseStream();
    }
    if (req.method === "POST" && url.pathname === "/api/observe") {
      return sseStream();
    }

    // Static file serving
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server listening on http://localhost:${server.port}`);
