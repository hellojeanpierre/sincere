import { basename } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute against the working directory" }),
});

const ALLOWED_BINARIES = new Set([
  "grep",
  "awk",
  "sed",
  "jq",
  "wc",
  "cat",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  // python3 is a full escape hatch — it can import os, subprocess, etc.
  // This is accepted risk: we need it for computation and trust the Operator
  // prompt to use it safely. The guard is defence-in-depth, not a sandbox.
  "python3",
]);

const SHELL_CHAIN_PATTERN = /;|&&|\|\||`|\$\(/;
const REDIRECT_PATTERN = />{1,2}/;

function validateCommand(command: string): string | null {
  if (SHELL_CHAIN_PATTERN.test(command)) {
    return "Error: command contains disallowed shell operator (;, &&, ||, $( ), or backticks)";
  }

  if (REDIRECT_PATTERN.test(command)) {
    return "Error: command contains disallowed redirect operator (> or >>)";
  }

  const segments = command.split("|");
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const firstToken = trimmed.split(/\s+/)[0];
    const bin = basename(firstToken);
    if (!ALLOWED_BINARIES.has(bin)) {
      return `Error: binary not allowed: ${bin}. Allowed: ${[...ALLOWED_BINARIES].join(", ")}`;
    }
  }

  return null;
}

export const execTool: AgentTool<typeof execSchema> = {
  name: "exec",
  label: "Execute Command",
  description:
    "Run a shell command in the project working directory and return stdout/stderr. Only allowlisted read-only binaries are permitted: grep, awk, sed, jq, wc, cat, head, tail, sort, uniq, cut, tr, python3. No shell chaining (;, &&, ||), no redirects (>, >>), no command substitution ($(), backticks). 30-second timeout.",
  parameters: execSchema,
  async execute(_toolCallId, params) {
    const error = validateCommand(params.command);
    if (error) {
      return {
        content: [{ type: "text", text: error }],
        details: null,
      };
    }

    const start = performance.now();

    const proc = Bun.spawn(["sh", "-c", params.command], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, 30_000);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timeout);

    const durationMs = Math.round(performance.now() - start);

    if (proc.signalCode) {
      logger.info({ command: params.command, durationMs, signal: proc.signalCode }, "exec timeout");
      return {
        content: [{ type: "text", text: `Error: command timed out after 30s` }],
        details: null,
      };
    }

    let text = stdout;
    if (stderr) {
      text += text ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
    }
    if (!text) {
      text = "(no output)";
    }

    logger.info({ command: params.command, exitCode, durationMs }, "exec command");

    return {
      content: [{ type: "text", text }],
      details: { command: params.command, exitCode, durationMs },
    };
  },
};
