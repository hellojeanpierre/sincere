import { describe, test, expect } from "bun:test";
import { createObserver } from "./observer.ts";
import { createLane } from "./lane.ts";

describe("observer", () => {
  const observer = createObserver();
  const lane = createLane(observer.handler);

  test(
    "sequential events for the same work item build session history",
    async () => {
      const event1 = JSON.stringify({
        id: "evt-001",
        type: "zen:event-type:ticket.created",
        ticket: { id: 99001, subject: "Cannot login", status: "new" },
        timestamp: "2026-03-27T10:00:00Z",
      });

      const event2 = JSON.stringify({
        id: "evt-002",
        type: "zen:event-type:ticket.status_changed",
        ticket: { id: 99001, subject: "Cannot login", status: "open" },
        timestamp: "2026-03-27T10:05:00Z",
      });

      await lane.enqueue("99001", event1);
      const afterFirst = observer.sessions("99001");
      expect(afterFirst).toBeDefined();
      const firstLen = afterFirst!.length;
      expect(firstLen).toBeGreaterThan(0);

      await lane.enqueue("99001", event2);
      const afterSecond = observer.sessions("99001");
      expect(afterSecond).toBeDefined();
      expect(afterSecond!.length).toBeGreaterThan(firstLen);
    },
    { timeout: 120_000 },
  );

  test(
    "different work items have independent sessions",
    async () => {
      const event = JSON.stringify({
        id: "evt-003",
        type: "zen:event-type:ticket.created",
        ticket: { id: 99002, subject: "Billing issue", status: "new" },
        timestamp: "2026-03-27T11:00:00Z",
      });

      await lane.enqueue("99002", event);
      const session = observer.sessions("99002");
      expect(session).toBeDefined();

      // Session for 99002 should be independent (shorter than 99001 which had two events)
      const session99001 = observer.sessions("99001");
      expect(session99001!.length).toBeGreaterThan(session!.length);
    },
    { timeout: 120_000 },
  );
});
