import { logger } from "./lib/logger.ts";

export type Handler<T = string> = (payload: T, workItemId: string) => Promise<void>;
export type Lane<T = string> = ReturnType<typeof createLane<T>>;

export function createLane<T = string>(handler: Handler<T>) {
  const lanes = new Map<string, Promise<void>>();

  return {
    enqueue(workItemId: string, payload: T): Promise<void> {
      const prev = lanes.get(workItemId) ?? Promise.resolve();
      const next = prev
        .then(() =>
          handler(payload, workItemId).catch((err) => {
            logger.error({ workItemId, err }, "lane handler error");
          }),
        )
        .finally(() => {
          if (lanes.get(workItemId) === next) lanes.delete(workItemId);
        });
      lanes.set(workItemId, next);
      return next;
    },
  };
}
