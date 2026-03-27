import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Handler } from "./lane.ts";
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

    const parts: string[] = [];
    let error: string | undefined;

    const unsub = agent.subscribe((e) => {
      if (e.type === "message_end") {
        const msg = e.message;
        if ("role" in msg && msg.role === "assistant") {
          const assistant = msg as AssistantMessage;
          if (assistant.stopReason === "error" && assistant.errorMessage) {
            error = assistant.errorMessage;
          }
          for (const block of assistant.content) {
            if (block.type === "text") {
              parts.push(block.text);
            }
          }
        }
      }
    });

    try {
      await agent.prompt(body);
    } finally {
      unsub();
    }

    store.set(workItemId, [...agent.state.messages]);

    if (error) {
      throw new Error(`Observer agent error: ${error}`);
    }

    const response = parts.join("\n");
    logger.info({ workItemId, responseLength: response.length }, "observer response");
  };

  return {
    handler,
    sessions(workItemId: string): AgentMessage[] | undefined {
      return store.get(workItemId);
    },
  };
}
