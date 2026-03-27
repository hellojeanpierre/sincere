import { logger } from "./lib/logger.ts";

export type Handler = (body: string, workItemId: string) => Promise<void>;

export function createLane(handler: Handler) {
  const lanes = new Map<string, Promise<void>>();

  return {
    enqueue(workItemId: string, body: string): Promise<void> {
      const prev = lanes.get(workItemId) ?? Promise.resolve();
      const next = prev.then(() =>
        handler(body, workItemId).catch((err) => {
          logger.error({ workItemId, err }, "lane handler error");
        }),
      );
      lanes.set(workItemId, next);
      return next;
    },
  };
}
