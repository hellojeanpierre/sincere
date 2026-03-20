import { readFileSync } from "fs";
import { resolve } from "path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "./lib/logger.ts";

const systemPrompt = readFileSync(
  resolve(import.meta.dirname, "operator.md"),
  "utf-8",
);

const model = getModel("anthropic", "claude-sonnet-4-6");

const echoSchema = Type.Object({
  message: Type.String({ description: "The message to echo back" }),
});

const echoTool: AgentTool<typeof echoSchema> = {
  name: "echo",
  label: "Echo",
  description: "Returns the input text unchanged.",
  parameters: echoSchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: params.message }],
      details: null,
    };
  },
};

const agent = new Agent({
  streamFn: streamSimple,
  getApiKey: () => process.env.ANTHROPIC_API_KEY,
});

agent.setSystemPrompt(systemPrompt);
agent.setModel(model);
agent.setTools([echoTool]);

agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      logger.info("agent started");
      break;
    case "agent_end":
      logger.info("agent ended");
      break;
    case "turn_start":
      logger.info("turn started");
      break;
    case "turn_end":
      logger.info("turn ended");
      break;
    case "message_start":
      logger.info({ role: event.message.role }, "message started");
      break;
    case "message_end":
      logger.info({ role: event.message.role }, "message ended");
      break;
    case "tool_execution_start":
      logger.info({ tool: event.toolName, args: event.args }, "tool call");
      break;
    case "tool_execution_end":
      logger.info(
        { tool: event.toolName, isError: event.isError },
        "tool result",
      );
      break;
  }
});

logger.info("prompting agent…");
await agent.prompt("What tools do you have?");

// Print the final assistant text
const messages = agent.state.messages;
const last = messages[messages.length - 1];
if (last && last.role === "assistant") {
  for (const block of last.content) {
    if (block.type === "text") {
      logger.info({ text: block.text }, "assistant response");
    }
  }
}
