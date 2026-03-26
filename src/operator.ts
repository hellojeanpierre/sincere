import { mkdirSync, appendFileSync, symlinkSync, unlinkSync, existsSync, readFileSync, globSync } from "fs";
import { resolve, basename, relative } from "path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { logger } from "./lib/logger.ts";
import { readTool } from "./tools/read.ts";
import { execTool } from "./tools/exec.ts";

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

// Known simplification: age is measured in user turns, so stale pruning only
// activates in multi-turn conversations. Single-prompt runs never prune.
// Known design choice: trace logger sees full results (via tool_execution_end
// events) while the LLM sees compressed stubs. This divergence is intentional —
// traces are the audit log, context projection is for token efficiency.
export const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
  const ages = new Array<number>(messages.length);
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") userCount++;
    ages[i] = userCount;
  }

  return messages.map((msg, i) => {
    if (msg.role !== "toolResult" || msg.isError) return msg;

    if (ages[i] > 8) {
      return { ...msg, content: [{ type: "text" as const, text: `[stale result: ${msg.toolName}, ${ages[i]} turns ago]` }] };
    }

    const texts = msg.content.filter((b): b is TextContent => b.type === "text");
    const totalLen = texts.reduce((sum, b) => sum + b.text.length, 0);
    if (totalLen <= 3000) return msg;

    const joined = texts.map(b => b.text).join("\n");
    const preview = joined.length <= 500
      ? joined
      : joined.slice(0, 300) + "\n…\n" + joined.slice(-200);
    const nonText = msg.content.filter(b => b.type !== "text");
    return { ...msg, content: [{ type: "text" as const, text: `[${msg.toolName}: ${totalLen} chars]\n${preview}` }, ...nonText] };
  });
};

function parseSkillFrontmatter(f: string): { name: string; description: string; file: string } | null {
  let raw: string;
  try { raw = readFileSync(f, "utf-8"); } catch { return null; }
  if (!raw.startsWith("---") || raw.indexOf("\n---", 3) === -1) {
    logger.warn({ file: basename(f) }, "skill file missing frontmatter, skipped");
    return null;
  }
  const end = raw.indexOf("\n---", 3);
  const attrs: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (key && val) attrs[key] = val;
  }
  if (!attrs.name || !attrs.description) return null;
  return { name: attrs.name, description: attrs.description, file: relative(process.cwd(), f) };
}

export function loadSystemPrompt(srcDir: string): string {
  const operatorPrompt = readFileSync(resolve(srcDir, "operator.md"), "utf-8");

  const skillEnv = process.env.SKILL;
  const skillFiles = skillEnv
    ? [resolve(srcDir, "skills", `${skillEnv}.md`)]
    : globSync(resolve(srcDir, "skills", "*.md"));
  const skills = skillFiles.map(parseSkillFrontmatter).filter((s): s is NonNullable<typeof s> => s !== null);

  if (skillEnv && skills.length === 0) throw new Error(`SKILL=${skillEnv}: failed to load skills/${skillEnv}.md`);
  if (skillEnv) logger.info({ skill: skills[0].name }, "single skill loaded");

  const skillIndex = skills.length > 0
    ? `\n\n## Available skills\n\nIf a task matches a skill below, read the skill file before starting. The descriptions are for routing, not for working from.\n\n${skills.map((s) => `- **${s.name}** (${s.file}): ${s.description}`).join("\n")}`
    : "";
  return operatorPrompt + skillIndex;
}

export function createAgent(): Agent {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const srcDir = resolve(import.meta.dirname);
  const systemPrompt = loadSystemPrompt(srcDir);

  const modelId = (process.env.SINCERE_MODEL as typeof DEFAULT_MODEL) || DEFAULT_MODEL;
  const model = getModel("anthropic", modelId);

  return new Agent({
    streamFn: streamSimple,
    getApiKey: () => apiKey,
    transformContext,
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
