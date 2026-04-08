import type { Lane } from "./lane.ts";
import { logger } from "./lib/logger.ts";

export function startGateway(port: number, lane: Lane<Record<string, unknown>>) {
  const seen = new Set<string>();
  let nullCount = 0;

  return Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const body = await req.text();

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        nullCount++;
        logger.warn(
          { nullCount, bodySnippet: body.slice(0, 200), bytes: body.length },
          "gateway: malformed JSON",
        );
        return new Response(null, { status: 200 });
      }

      const id = (parsed.ticket as any)?.id ?? parsed.id;
      if (id == null) {
        nullCount++;
        logger.warn(
          { nullCount, bodySnippet: body.slice(0, 200), bytes: body.length },
          "gateway: no work item ID found",
        );
        return new Response(null, { status: 200 });
      }
      const workItemId = String(id);

      const ts = parsed.timestamp ?? parsed.updated_at;
      if (ts != null) {
        const dedup = `${workItemId}:${ts}`;
        if (seen.has(dedup)) {
          logger.info({ workItemId, dedup }, "gateway: duplicate skipped");
          return new Response(null, { status: 200 });
        }
        if (seen.size > 10_000) {
          logger.warn({ previousSize: seen.size }, "dedup set cleared");
          seen.clear();
        }
        seen.add(dedup);
      }

      // Fire-and-forget: Zendesk webhooks expect a fast 200, processing continues in the lane.
      lane.enqueue(workItemId, parsed);
      return new Response(null, { status: 200 });
    },
  });
}
