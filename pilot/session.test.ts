import { test, expect, mock } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Event } from "./events";
import type { RunTurnFn } from "./session";

let eventsState: {
  markProcessed: (source: string, id: string) => void;
  insertEvent: (e: Event) => "inserted" | "duplicate";
  getUnprocessedEvents: () => Event[];
};

mock.module("./events", () => ({
  markProcessed: (s: string, id: string) => eventsState.markProcessed(s, id),
  insertEvent: (e: Event) => eventsState.insertEvent(e),
  getUnprocessedEvents: () => eventsState.getUnprocessedEvents(),
}));

const { createSessionManager } = await import("./session");

function mockClient(overrides: {
  send?: (sessionId: string, body: { events: unknown }) => Promise<unknown>;
} = {}): Anthropic {
  let n = 0;
  return {
    beta: {
      files: { upload: async () => ({ id: "file-test" }) },
      sessions: {
        create: async () => ({ id: `sess-${++n}` }),
        events: {
          send: overrides.send ?? (async () => ({})),
          stream: async () => {
            throw new Error("stream should not be called when runTurnFn is injected");
          },
        },
      },
    },
  } as unknown as Anthropic;
}

test("two events for same ticket run serially", async () => {
  const bothDone = Promise.withResolvers<void>();
  const marks: string[] = [];
  eventsState = {
    markProcessed: (_s, id) => {
      marks.push(id);
      if (marks.length === 2) bothDone.resolve();
    },
    insertEvent: () => "inserted",
    getUnprocessedEvents: () => [],
  };

  const firstStarted = Promise.withResolvers<void>();
  const firstCanFinish = Promise.withResolvers<void>();
  let turnCalls = 0;
  let secondStarted = false;

  const runTurnFn: RunTurnFn = async () => {
    const i = ++turnCalls;
    if (i === 1) {
      firstStarted.resolve();
      await firstCanFinish.promise;
      return { text: "a", interrupted: false };
    }
    secondStarted = true;
    return { text: "b", interrupted: false };
  };

  const manager = createSessionManager({
    client: mockClient(),
    policyPath: import.meta.path,
    runTurnFn,
  });
  await manager.initSession();

  const base = {
    source: "test",
    type: "t",
    subjectId: "ticket-1",
    sourceTime: null,
    receivedAt: 0,
    payload: {},
  };
  manager.enqueueEvent({ ...base, sourceEventId: "A", receivedAt: 1 });
  manager.enqueueEvent({ ...base, sourceEventId: "B", receivedAt: 2 });

  await firstStarted.promise;
  expect(secondStarted).toBe(false);
  firstCanFinish.resolve();
  await bothDone.promise;
  expect(turnCalls).toBe(2);
});

test("new event dispatches interrupt to in-flight turn", async () => {
  const bothDone = Promise.withResolvers<void>();
  const marks = new Set<string>();
  eventsState = {
    markProcessed: (_s, id) => {
      marks.add(id);
      if (marks.size === 2) bothDone.resolve();
    },
    insertEvent: () => "inserted",
    getUnprocessedEvents: () => [],
  };

  const interruptSent = Promise.withResolvers<{ sessionId: string; events: unknown }>();
  const client = mockClient({
    send: async (sessionId, body) => {
      const events = body.events as Array<{ type: string }>;
      if (events.some((e) => e.type === "user.interrupt")) {
        interruptSent.resolve({ sessionId, events: body.events });
      }
      return {};
    },
  });

  const firstStarted = Promise.withResolvers<void>();
  const firstCanReturn = Promise.withResolvers<{ text: string; interrupted: boolean }>();
  let turnCalls = 0;
  const runTurnFn: RunTurnFn = async () => {
    if (++turnCalls === 1) {
      firstStarted.resolve();
      return firstCanReturn.promise;
    }
    return { text: "b", interrupted: false };
  };

  const manager = createSessionManager({
    client,
    policyPath: import.meta.path,
    runTurnFn,
  });
  await manager.initSession();

  const base = {
    source: "test",
    type: "t",
    subjectId: "ticket-1",
    sourceTime: null,
    receivedAt: 0,
    payload: {},
  };
  manager.enqueueEvent({ ...base, sourceEventId: "A", receivedAt: 1 });
  await firstStarted.promise;
  manager.enqueueEvent({ ...base, sourceEventId: "B", receivedAt: 2 });

  const sent = await Promise.race([
    interruptSent.promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("interrupt was not sent")), 200),
    ),
  ]);
  expect(sent).toEqual({
    sessionId: "sess-1",
    events: [{ type: "user.interrupt" }],
  });

  firstCanReturn.resolve({ text: "a", interrupted: true });
  await bothDone.promise;
  expect(marks).toEqual(new Set(["A", "B"]));
});

test("events supplied in order get processed in order", async () => {
  const bothDone = Promise.withResolvers<void>();
  const processedOrder: string[] = [];
  eventsState = {
    markProcessed: () => {
      if (processedOrder.length === 2) bothDone.resolve();
    },
    insertEvent: () => "inserted",
    getUnprocessedEvents: () => [
      {
        source: "test",
        sourceEventId: "A",
        type: "t",
        subjectId: "ticket-1",
        sourceTime: null,
        receivedAt: 1,
        payload: { id: "A" },
      },
      {
        source: "test",
        sourceEventId: "B",
        type: "t",
        subjectId: "ticket-1",
        sourceTime: null,
        receivedAt: 2,
        payload: { id: "B" },
      },
    ],
  };

  const runTurnFn: RunTurnFn = async (_sid, content) => {
    processedOrder.push((JSON.parse(content[0]!.text) as { id: string }).id);
    return { text: "ok", interrupted: false };
  };

  const manager = createSessionManager({
    client: mockClient(),
    policyPath: import.meta.path,
    runTurnFn,
  });
  await manager.initSession();

  for (const event of eventsState.getUnprocessedEvents()) manager.enqueueEvent(event);

  await bothDone.promise;
  expect(processedOrder).toEqual(["A", "B"]);
});
