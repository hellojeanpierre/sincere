import { logger } from "./lib/logger.ts";

export function startGateway(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const body = await req.text();
      logger.info({ bytes: body.length }, "gateway received");
      return new Response(null, { status: 200 });
    },
  });
}
