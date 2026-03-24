import { mkdirSync, appendFileSync, symlinkSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "./lib/logger.ts";
import { readTool } from "./tools/read.ts";
import { execTool } from "./tools/exec.ts";
import { loadSystemPrompt } from "./lib/load-prompt.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6" as const;

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

export function createAgent(): Agent {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const systemPrompt = loadSystemPrompt(resolve(import.meta.dirname));
  const modelId = (process.env.SINCERE_MODEL as typeof DEFAULT_MODEL) || DEFAULT_MODEL;
  const model = getModel("anthropic", modelId);

  return new Agent({
    streamFn: streamSimple,
    getApiKey: () => apiKey,
    initialState: {
      systemPrompt,
      model,
      tools: [echoTool, readTool, execTool],
      thinkingLevel: "high",
    },
  });
}

// --- Run only when executed directly (not imported by tests) ---
if (import.meta.main) {
  runOperator().catch((err) => {
    logger.fatal(err);
    process.exit(1);
  });
}

async function runOperator() {

const agent = createAgent();

// --- Trace logging to markdown ---
const tracesDir = resolve("data/traces");
mkdirSync(tracesDir, { recursive: true });

let traceTimestamp = "";
let traceFile = "";
let traceStartTime = Date.now();

function traceAppend(content: string) {
  try {
    appendFileSync(traceFile, content + "\n\n");
  } catch (err) {
    logger.error({ err, traceFile }, "failed to write trace");
  }
}

function formatEvent(event: Parameters<Parameters<typeof agent.subscribe>[0]>[0]): string | null {
  switch (event.type) {
    case "agent_start":
      return null; // handled separately to write H1
    case "agent_end": {
      const durationSec = ((Date.now() - traceStartTime) / 1000).toFixed(1);
      return `## Investigation Ended\n\nDuration: ${durationSec}s`;
    }
    case "message_end":
      if (event.message.role === "assistant") {
        const parts: string[] = [];
        for (const b of event.message.content) {
          if (b.type === "thinking" && b.thinking) {
            parts.push(`<details><summary>Thinking</summary>\n\n${b.thinking}\n\n</details>`);
          } else if (b.type === "text") {
            parts.push(b.text);
          }
        }
        if (parts.length > 0) {
          return `## Assistant\n\n${parts.join("\n\n")}`;
        }
      }
      return null;
    case "tool_execution_start": {
      const args = event.args as Record<string, unknown>;
      const yamlish = Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
      return `## Tool Call: ${event.toolName}\n\n${yamlish}`;
    }
    case "tool_execution_end": {
      const result = event.result;
      const text = result?.content
        ?.filter((b: { type: string }): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n") ?? "(no text content)";
      const prefix = event.isError ? "[ERROR] " : "";
      return `## Tool Result: ${event.toolName}\n\n${prefix}${text}`;
    }
    default:
      return null;
  }
}

agent.subscribe((event) => {
  // Trace logging
  if (event.type === "agent_start") {
    traceStartTime = Date.now();
    traceTimestamp = new Date().toISOString();
    traceFile = resolve(tracesDir, `${traceTimestamp.replaceAll(":", "-")}.md`);
    traceAppend(`# Investigation Trace — ${traceTimestamp}`);
  }
  const formatted = formatEvent(event);
  if (formatted) {
    traceAppend(formatted);
  }
  if (event.type === "agent_end") {
    // Symlink latest.md
    const latestLink = resolve(tracesDir, "latest.md");
    if (existsSync(latestLink)) unlinkSync(latestLink);
    symlinkSync(traceFile, latestLink);
  }

  // Existing pino logging
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
await agent.prompt("Analyze data/pintest-v1/manifest.json");

} // end runOperator
