import { describe, test, expect } from "bun:test";
import { createLane } from "./lane.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lane", () => {
  test("same work item executes serially", async () => {
    const log: { start: number; end: number }[] = [];

    const lane = createLane(async () => {
      const start = performance.now();
      await delay(30);
      log.push({ start, end: performance.now() });
    });

    const p1 = lane.enqueue("wk-1", "a");
    const p2 = lane.enqueue("wk-1", "b");
    const p3 = lane.enqueue("wk-1", "c");
    await Promise.all([p1, p2, p3]);

    expect(log).toHaveLength(3);
    expect(log[1].start).toBeGreaterThanOrEqual(log[0].end);
    expect(log[2].start).toBeGreaterThanOrEqual(log[1].end);
  });

  test("different work items execute concurrently", async () => {
    const starts: number[] = [];
    const ends: number[] = [];

    const lane = createLane(async () => {
      starts.push(performance.now());
      await delay(30);
      ends.push(performance.now());
    });

    const p1 = lane.enqueue("wk-a", "x");
    const p2 = lane.enqueue("wk-b", "y");
    const p3 = lane.enqueue("wk-c", "z");
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

    const lane = createLane(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      secondProcessed = true;
    });

    const p1 = lane.enqueue("wk-err", "first");
    const p2 = lane.enqueue("wk-err", "second");
    await Promise.all([p1, p2]);

    expect(callCount).toBe(2);
    expect(secondProcessed).toBe(true);
  });
});
