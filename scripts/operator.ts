import { resolve } from "path";
import { createAgent } from "../src/agent.ts";
import { logger } from "../src/lib/logger.ts";
import { subscribeTrace } from "../src/lib/trace.ts";

if (import.meta.main) {
  runOperator().catch((err) => {
    logger.fatal(err);
    process.exit(1);
  });
}

async function runOperator() {

const { agent, dispose } = createAgent({
  promptPath: resolve(import.meta.dirname, "../src/operator.md"),
  model: process.env.MODEL || "claude-sonnet-4-6",
  thinkingLevel: "high",
});

const _unsubTrace = subscribeTrace(agent, "operator");

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
try {
  await agent.prompt("Analyze data/pintest-v1/manifest.json");
} finally {
  await dispose();
}

} // end runOperator
