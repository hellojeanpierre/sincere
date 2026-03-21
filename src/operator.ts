import { readFileSync } from "fs";
import { resolve } from "path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "./lib/logger.ts";
import { readTool } from "./tools/read.ts";
import { execTool } from "./tools/exec.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6" as const;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  logger.fatal("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const systemPrompt = readFileSync(
  resolve(import.meta.dirname, "operator.md"),
  "utf-8",
);

const modelId = (process.env.SINCERE_MODEL as typeof DEFAULT_MODEL) || DEFAULT_MODEL;
const model = getModel("anthropic", modelId);

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
  getApiKey: () => apiKey,
  initialState: {
    systemPrompt,
    model,
    tools: [echoTool, readTool, execTool],
  },
});

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
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stderr.write(event.assistantMessageEvent.delta);
      }
      break;
    case "message_end":
      if (event.message.role === "assistant") {
        process.stderr.write("\n");
      }
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
await agent.prompt("");
