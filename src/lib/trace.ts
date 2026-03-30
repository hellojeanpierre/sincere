import { mkdirSync, appendFileSync, symlinkSync, unlinkSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import type { Agent } from "@mariozechner/pi-agent-core";
import { logger } from "./logger.ts";

export type TraceSource = "operator" | "demo";

// Anchor to repo root (src/lib/ → ../../data/traces) so traces land in the
// right place regardless of the caller's cwd.
const tracesDir = resolve(dirname(import.meta.path), "../../data/traces");

function formatEvent(event: Parameters<Parameters<Agent["subscribe"]>[0]>[0], startTime: number): string | null {
  switch (event.type) {
    case "agent_start":
      return null; // handled separately to write H1
    case "agent_end": {
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      return `## Investigation Ended\n\nDuration: ${durationSec}s`;
    }
    case "message_end":
      if (event.message.role === "assistant") {
        const parts: string[] = [];
        for (const b of event.message.content) {
          if (b.type === "thinking") {
            const text = b.redacted ? "[redacted]" : b.thinking || "[empty]";
            parts.push(`<details><summary>Thinking</summary>\n\n${text}\n\n</details>`);
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
        .map((b: { type: "text"; text: string }) => b.text)
        .join("\n") ?? "(no text content)";
      const prefix = event.isError ? "[ERROR] " : "";
      return `## Tool Result: ${event.toolName}\n\n${prefix}${text}`;
    }
    default:
      return null;
  }
}

export function subscribeTrace(agent: Agent, source: TraceSource): () => void {
  mkdirSync(tracesDir, { recursive: true });

  let traceFile = "";
  let startTime = 0;

  function traceAppend(content: string) {
    if (!traceFile) return;
    try {
      appendFileSync(traceFile, content + "\n\n");
    } catch (err) {
      logger.error({ err, traceFile }, "failed to write trace");
    }
  }

  return agent.subscribe((event) => {
    if (event.type === "agent_start") {
      startTime = Date.now();
      const timestamp = new Date().toISOString();
      traceFile = resolve(tracesDir, `${timestamp.replaceAll(":", "-")}.md`);
      traceAppend(`# Investigation Trace — ${timestamp} [${source}]`);
      return;
    }

    const formatted = formatEvent(event, startTime);
    if (formatted) {
      traceAppend(formatted);
    }

    if (event.type === "agent_end") {
      const latestLink = resolve(tracesDir, "latest.md");
      if (existsSync(latestLink)) unlinkSync(latestLink);
      symlinkSync(basename(traceFile), latestLink);
    }
  });
}
