import { logger } from "./lib/logger.ts";

export type Handler = (body: string, workItemId: string) => Promise<void>;

const defaultHandler: Handler = async (body, workItemId) => {
  logger.info({ workItemId, bytes: body.length }, "lane received");
};

const lanes = new Map<string, Promise<void>>();

export function enqueue(
  workItemId: string,
  body: string,
  handler: Handler = defaultHandler,
): Promise<void> {
  const prev = lanes.get(workItemId) ?? Promise.resolve();
  const next = prev.then(() =>
    handler(body, workItemId).catch((err) => {
      logger.error({ workItemId, err }, "lane handler error");
    }),
  );
  lanes.set(workItemId, next);
  return next;
}
