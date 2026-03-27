import { describe, test, expect } from "bun:test";
import { enqueue } from "./lane.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lane", () => {
  test("same work item executes serially", async () => {
    const log: { start: number; end: number }[] = [];

    const handler = async () => {
      const start = performance.now();
      await delay(30);
      log.push({ start, end: performance.now() });
    };

    const p1 = enqueue("wk-1", "a", handler);
    const p2 = enqueue("wk-1", "b", handler);
    const p3 = enqueue("wk-1", "c", handler);
    await Promise.all([p1, p2, p3]);

    expect(log).toHaveLength(3);
    expect(log[1].start).toBeGreaterThanOrEqual(log[0].end);
    expect(log[2].start).toBeGreaterThanOrEqual(log[1].end);
  });

  test("different work items execute concurrently", async () => {
    const starts: number[] = [];
    const ends: number[] = [];

    const handler = async () => {
      starts.push(performance.now());
      await delay(30);
      ends.push(performance.now());
    };

    const p1 = enqueue("wk-a", "x", handler);
    const p2 = enqueue("wk-b", "y", handler);
    const p3 = enqueue("wk-c", "z", handler);
    await Promise.all([p1, p2, p3]);

    expect(starts).toHaveLength(3);
    // At least 2 started before the first one finished
    const firstEnd = Math.min(...ends);
    const startedBeforeFirstEnd = starts.filter((s) => s < firstEnd).length;
    expect(startedBeforeFirstEnd).toBeGreaterThanOrEqual(2);
  });

  test("handler error does not break the lane", async () => {
    let callCount = 0;
    let secondProcessed = false;

    const handler = async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      secondProcessed = true;
    };

    const p1 = enqueue("wk-err", "first", handler);
    const p2 = enqueue("wk-err", "second", handler);
    await Promise.all([p1, p2]);

    expect(callCount).toBe(2);
    expect(secondProcessed).toBe(true);
  });
});
