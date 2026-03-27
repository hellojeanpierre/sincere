import { logger } from "./lib/logger.ts";
import { enqueue } from "./lane.ts";

export function extractWorkItemId(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const id = parsed?.ticket?.id ?? parsed?.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

export function startGateway(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const body = await req.text();
      const workItemId = extractWorkItemId(body);
      if (workItemId == null) {
        logger.warn({ bytes: body.length }, "gateway: no work item ID found");
        return new Response(null, { status: 200 });
      }
      enqueue(workItemId, body);
      return new Response(null, { status: 200 });
    },
  });
}
