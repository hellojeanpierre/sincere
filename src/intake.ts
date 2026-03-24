import type { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

/**
 * Feed a single Zendesk event to the agent and return its text response.
 * The event is passed as-is in Zendesk Event API format — no transformation.
 */
export async function intake(
  agent: Agent,
  event: Record<string, unknown>,
): Promise<string> {
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
    await agent.prompt(
      `Incoming Zendesk event:\n\n${JSON.stringify(event, null, 2)}`,
    );
  } finally {
    unsub();
  }

  if (error) {
    throw new Error(`Agent error: ${error}`);
  }

  return parts.join("\n");
}
