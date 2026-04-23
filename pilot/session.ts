import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";
import type { Event } from "./events";
import { markProcessed } from "./events";

type StreamEvent = Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;

const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";
const ENVIRONMENT_ID = "env_01BeAimUGVuvGamH6fgfiUTa";

const POLICY_PATH = join(import.meta.dir, "..", "data", "pintest-v2", "smoke-tickets", "policy.jsonl");

interface InitState {
  client: Anthropic;
  policyFileId: string;
}

let state: InitState | null = null;
const sessionsBySubject = new Map<string, string>();
const chains = new Map<string, Promise<void>>();

interface ActiveStream {
  sessionId: string;
  interrupted: boolean;
}
const activeStreams = new Map<string, ActiveStream>();

export async function initSession(): Promise<void> {
  if (state) return;
  const client = new Anthropic();
  const blob = Bun.file(POLICY_PATH);
  const uploaded = await client.beta.files.upload({
    file: new File([await blob.arrayBuffer()], "policy.jsonl", { type: blob.type }),
  });
  console.log(`Uploaded policy.jsonl: ${uploaded.id}`);
  state = { client, policyFileId: uploaded.id };
}

function requireState(): InitState {
  if (!state) throw new Error("session module not initialized — call initSession() first");
  return state;
}

export function getSession(subjectKey: string): string | null {
  return sessionsBySubject.get(subjectKey) ?? null;
}

export async function createSession(subjectKey: string): Promise<string> {
  const { client, policyFileId } = requireState();
  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    resources: [
      { type: "file", file_id: policyFileId, mount_path: "/mnt/session/uploads/policy.jsonl" },
    ],
  });
  console.log(`Session created for ${subjectKey}: ${session.id}`);
  const prior = sessionsBySubject.get(subjectKey);
  if (prior) {
    console.warn(`Overwriting prior session ${prior} for ${subjectKey} (orphaned)`);
  }
  sessionsBySubject.set(subjectKey, session.id);
  return session.id;
}

export async function runTurn(
  sessionId: string,
  content: Array<{ type: "text"; text: string }>,
  subjectKey?: string,
): Promise<{ text: string; interrupted: boolean }> {
  const { client } = requireState();
  const stream = (await client.beta.sessions.events.stream(sessionId)) as AsyncIterable<StreamEvent>;

  if (subjectKey) {
    activeStreams.set(subjectKey, { sessionId, interrupted: false });
  }

  try {
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content }],
    });

    const texts: string[] = [];
    for await (const event of stream) {
      console.log(`[${sessionId}] event: ${event.type}`);

      if (event.type === "agent.message") {
        for (const block of (event as { content: Array<{ type: string; text?: string }> }).content) {
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        }
      }

      if (event.type === "session.error") {
        const e = event as { error: { message: string } };
        throw new Error(`session.error: ${e.error.message}`);
      }

      if (event.type === "session.status_idle") {
        const stopType = event.stop_reason.type;
        if (stopType === "end_turn") {
          return { text: texts.join("\n"), interrupted: false };
        }
        const wasInterrupted = subjectKey ? activeStreams.get(subjectKey)?.interrupted === true : false;
        if (wasInterrupted) {
          console.log(`[${sessionId}] stream interrupted (stop_reason=${stopType}); exiting turn`);
          return { text: texts.join("\n"), interrupted: true };
        }
        throw new Error(`Unexpected stop_reason: ${stopType}`);
      }
    }

    return { text: texts.join("\n"), interrupted: false };
  } finally {
    if (subjectKey) activeStreams.delete(subjectKey);
  }
}

export function enqueueEvent(event: Event): void {
  if (!event.subjectId) {
    console.error(`[session] cannot enqueue ${event.sourceEventId}: missing subjectId`);
    // Mark processed so we don't replay this row forever — a missing
    // subjectId is a permanent payload defect, not a transient failure.
    markProcessed(event.source, event.sourceEventId);
    return;
  }
  const key = event.subjectId;

  // Only the currently-active turn gets interrupted. If events B and C are
  // both queued behind an in-flight turn A, enqueuing C sets
  // activeStreams[key].interrupted = true (which targets A), but B will
  // still run to completion on its turn in the chain. At pilot scale this
  // is acceptable — the Analyst processes B and C sequentially and catches
  // up on state. A future fix would propagate interrupt intent through the
  // chain so middle-queued events can coalesce too.
  const active = activeStreams.get(key);
  if (active) {
    active.interrupted = true;
    const { client } = requireState();
    client.beta.sessions.events.send(active.sessionId, {
      events: [{ type: "user.interrupt" }],
    }).catch((err) => console.error(`[session] interrupt send failed for ${key}:`, err));
  }

  const prev = chains.get(key) ?? Promise.resolve();
  const task: Promise<void> = prev.then(async () => {
    try {
      const sessionId = getSession(key) ?? (await createSession(key));
      const result = await runTurn(
        sessionId,
        [{ type: "text", text: JSON.stringify(event.payload, null, 2) }],
        key,
      );
      if (result.interrupted) {
        console.log(`[session] event ${event.sourceEventId} superseded by newer event; marking processed`);
      }
      markProcessed(event.source, event.sourceEventId);
    } catch (err) {
      console.error(`[session] turn failed for ${event.sourceEventId}:`, err);
    }
  });

  const storedTask = task.catch(() => {});
  chains.set(key, storedTask);
  storedTask.finally(() => {
    if (chains.get(key) === storedTask) chains.delete(key);
  });
}
