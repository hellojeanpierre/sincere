import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";
import type { Event } from "./events";

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
): Promise<string> {
  const { client } = requireState();
  const stream = await client.beta.sessions.events.stream(sessionId);

  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content }],
  });

  const texts: string[] = [];
  for await (const event of stream as AsyncIterable<StreamEvent>) {
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
      if (stopType === "end_turn") break;
      throw new Error(`Unexpected stop_reason: ${stopType}`);
    }
  }

  return texts.join("\n");
}

export async function dispatchEvent(event: Event): Promise<string> {
  if (!event.subjectId) {
    throw new Error(`cannot dispatch event ${event.sourceEventId}: missing subjectId`);
  }
  const sessionId = getSession(event.subjectId) ?? (await createSession(event.subjectId));
  return runTurn(sessionId, [{
    type: "text",
    text: JSON.stringify(event.payload, null, 2),
  }]);
}
