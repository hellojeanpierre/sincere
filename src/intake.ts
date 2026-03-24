import type { Agent } from "@mariozechner/pi-agent-core";

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
    if (
      e.type === "message_end" &&
      (e.message as any).role === "assistant"
    ) {
      const msg = e.message as any;
      if (msg.stopReason === "error" && msg.errorMessage) {
        error = msg.errorMessage;
      }
      for (const block of msg.content ?? []) {
        if (block.type === "text") {
          parts.push(block.text);
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

  if (error && parts.length === 0) {
    throw new Error(`Agent error: ${error}`);
  }

  return parts.join("\n");
}
