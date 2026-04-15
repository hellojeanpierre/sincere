import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources/beta";

// ── Tool definition ──────────────────────────────────────────────

type ToolParam = NonNullable<Beta.Agents.AgentUpdateParams["tools"]>[number];

export const CRON_TOOL = {
  type: "custom" as const,
  name: "cron",
  description: `Schedule a future check-in on a ticket. This tool exists
because event-driven monitoring has a blind spot: it can detect what
happened, but not what failed to happen next. When you observe a step
that should lead to a follow-up (investigation completed, triage done,
escalation requested) but the follow-up hasn't arrived in the same
event batch, this tool lets you check back later to see if it did.

SLA tracking and status changes are already handled by Zendesk's own
infrastructure — they produce their own events. This tool covers the
gap between "a step was completed" and "the expected next step never
came," which nothing else monitors.

When the check fires you will receive the ticket's current state.
Compare it to where it was when you scheduled the check.`,
  input_schema: {
    type: "object" as const,
    properties: {
      delay_minutes: {
        type: "number",
        description:
          "Minutes from now to trigger the check-in. Use 60\u2013120 for actions expected within the same shift, 1440 for next-business-day follow-ups.",
      },
    },
    required: ["delay_minutes"],
  },
};

// ── Idempotent registration ──────────────────────────────────────

export async function ensureCronTool(
  client: Anthropic,
  agentId: string,
): Promise<void> {
  try {
    const agent = await client.beta.agents.retrieve(agentId);
    const hasCron = agent.tools.some(
      (t) => t.type === "custom" && t.name === "cron",
    );
    if (hasCron) return;

    await client.beta.agents.update(agentId, {
      version: agent.version,
      tools: [...(agent.tools as ToolParam[]), CRON_TOOL],
    });
  } catch (err) {
    console.error("ensureCronTool failed:", err);
    process.exit(1);
  }
}
