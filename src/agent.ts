import { readFileSync, globSync, existsSync, unlinkSync, symlinkSync, mkdirSync } from "fs";
import { resolve, basename, relative, dirname } from "path";
import { writeFile, mkdir } from "fs/promises";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentTool, AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Handler } from "./lane.ts";
import { intake } from "./intake.ts";
import { logger } from "./lib/logger.ts";
import { readTool } from "./tools/read.ts";
import { execTool } from "./tools/exec.ts";
import { resolveConfig } from "./lib/config.ts";

// Microcompaction: persist oversized stale tool results to disk, keep a 2k
// preview inline. Fresh results (within the last FRESH_WINDOW_TURNS assistant
// turns) pass through unchanged — exec owns the size gate for those.
const FRESH_WINDOW_TURNS = 4;

export function makeTransformContext(sessionDir: string, hintDir: string) {
  let dirReady = false;

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // Find freshBoundary: index of the FRESH_WINDOW_TURNS-th assistant message
    // from the end. Everything at or after this index is fresh.
    let assistantCount = 0;
    // 0 means all messages are in the fresh window — correct default when the
    // conversation has fewer than FRESH_WINDOW_TURNS assistant turns.
    let freshBoundary = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        assistantCount++;
        if (assistantCount >= FRESH_WINDOW_TURNS) {
          freshBoundary = i;
          break;
        }
      }
    }

    return Promise.all(messages.map(async (msg, idx) => {
      if (msg.role !== "toolResult" || msg.isError) return msg;
      // Assumes ordering: user → assistant → toolResult(s). If multiple
      // toolResults follow one assistant message, this index-based check still
      // holds — they all share the same stale/fresh classification. Would only
      // misclassify if toolResults appeared before their assistant message.
      if (idx >= freshBoundary) return msg;

      const trMsg = msg as ToolResultMessage;
      const texts = trMsg.content.filter((b): b is TextContent => b.type === "text");
      const totalLen = texts.reduce((sum, b) => sum + b.text.length, 0);

      if (totalLen > 10_000 && trMsg.toolCallId) {
        const joined = texts.map(b => b.text).join("\n");
        const safeId = trMsg.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const writePath = `${sessionDir}/${safeId}.txt`;
        const hintPath = `${hintDir}/${safeId}.txt`;
        const nonText = trMsg.content.filter(b => b.type !== "text");
        const preview = joined.slice(0, 2_000);
        try {
          if (!dirReady) {
            await mkdir(sessionDir, { recursive: true });
            dirReady = true;
          }
          await writeFile(writePath, joined);
          logger.info({ toolCallId: trMsg.toolCallId, toolName: trMsg.toolName, chars: totalLen, path: writePath }, "microcompaction persisted");
          return {
            ...trMsg,
            content: [
              { type: "text" as const, text: preview + `\n\n[Full output persisted to ${hintPath} — use read tool to access]` },
              ...nonText,
            ],
          };
        } catch (err) {
          logger.error({ toolCallId: trMsg.toolCallId, err }, "microcompaction write failed, truncating without persistence");
          return {
            ...trMsg,
            content: [
              { type: "text" as const, text: preview + `\n\n[Full output lost — persistence failed]` },
              ...nonText,
            ],
          };
        }
      }

      return msg;
    }));
  };
}

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

export function loadSystemPrompt(promptPath: string): string {
  let prompt = readFileSync(promptPath, "utf-8");
  const srcDir = dirname(promptPath);

  // Generic template resolution: replace {{key}} placeholders with values
  // from config.json. Prompts without placeholders pass through unchanged.
  const vars = resolveConfig(srcDir);
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }

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
  return prompt + skillIndex;
}

export interface AgentOptions {
  promptPath: string;
  model: string;
  tools?: AgentTool<any>[];
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

export function createAgent(opts: AgentOptions): Agent {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const srcDir = dirname(opts.promptPath);
  const sessionsBase = resolve(srcDir, "..", "data/sessions");
  const sessionId = new Date().toISOString().replaceAll(":", "-");
  const sessionDir = resolve(sessionsBase, sessionId, "tool-results");
  const hintDir = "data/sessions/latest/tool-results";

  // Create/update the latest symlink (relative target so it works from the sessions dir)
  mkdirSync(sessionsBase, { recursive: true });
  const latestLink = resolve(sessionsBase, "latest");
  if (existsSync(latestLink)) unlinkSync(latestLink);
  symlinkSync(sessionId, latestLink);

  const systemPrompt = loadSystemPrompt(opts.promptPath);
  const model = getModel("anthropic", opts.model);
  const tools: AgentTool<any>[] = [readTool, execTool(sessionDir), ...(opts.tools ?? []).filter(t => t.name !== "exec")];

  return new Agent({
    streamFn: streamSimple,
    getApiKey: () => apiKey,
    transformContext: makeTransformContext(sessionDir, hintDir),
    initialState: {
      systemPrompt,
      model,
      tools,
      thinkingLevel: opts.thinkingLevel ?? "high",
    },
  });
}

export function createSessionHandler(createAgentFn: () => Agent) {
  const store = new Map<string, AgentMessage[]>();

  const handler: Handler = async (body, workItemId) => {
    logger.info({ workItemId }, "handler start");
    const saved = store.get(workItemId) ?? [];
    const agent = createAgentFn();

    if (saved.length > 0) {
      agent.replaceMessages(saved);
    }

    try {
      const event = JSON.parse(body) as Record<string, unknown>;
      const response = await intake(agent, event);
      logger.info(
        { workItemId, responsePreview: response.slice(0, 1000) },
        "handler response",
      );
      store.set(workItemId, [...agent.state.messages]);
    } catch (err) {
      logger.error({ workItemId, err }, "handler failed, session not updated");
      throw err;
    }
  };

  return {
    handler,
    sessions(workItemId: string): AgentMessage[] | undefined {
      const saved = store.get(workItemId);
      return saved ? [...saved] : undefined;
    },
  };
}
