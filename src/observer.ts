import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Handler } from "./lane.ts";
import { intake } from "./intake.ts";
import { logger } from "./lib/logger.ts";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001" as const;

const SYSTEM_PROMPT = "You are observing events on a work item. Summarize what just happened.";

export function createObserver() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const modelId = (process.env.MODEL as typeof DEFAULT_MODEL) || DEFAULT_MODEL;
  const model = getModel("anthropic", modelId);

  const store = new Map<string, AgentMessage[]>();

  const handler: Handler = async (body, workItemId) => {
    const saved = store.get(workItemId) ?? [];

    const agent = new Agent({
      streamFn: streamSimple,
      getApiKey: () => apiKey,
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        tools: [],
        thinkingLevel: "off",
      },
    });

    if (saved.length > 0) {
      agent.replaceMessages(saved);
    }

    const event = JSON.parse(body) as Record<string, unknown>;
    const response = await intake(agent, event);

    store.set(workItemId, [...agent.state.messages]);

    logger.info({ workItemId, responseLength: response.length }, "observer response");
  };

  return {
    handler,
    sessions(workItemId: string): AgentMessage[] | undefined {
      return store.get(workItemId);
    },
  };
}
