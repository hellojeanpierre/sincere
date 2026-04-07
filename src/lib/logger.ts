import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

export const logger = pino({ name: "sincere" });

export interface TraceSink {
  workItemId: string;
  write(line: string): void;
}

const traceALS = new AsyncLocalStorage<TraceSink>();

export function startTraceSink<T>(sink: TraceSink, fn: () => T): T {
  return traceALS.run(sink, fn);
}

export function traceEvent(type: string, payload: Record<string, unknown>): void {
  const sink = traceALS.getStore();
  if (!sink) return;
  try {
    sink.write(JSON.stringify({ ts: Date.now(), type, workItemId: sink.workItemId, ...payload }) + "\n");
  } catch {
    // Best-effort — tracing must never disrupt the agent control path.
  }
}
