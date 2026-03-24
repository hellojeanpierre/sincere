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

/**
 * Quote-aware shell tokenizer. Walks the command string character-by-character,
 * tracking quote context to distinguish real shell operators from characters
 * inside quoted arguments.
 *
 * Returns pipe-delimited segments for allowlist checking, or an error string
 * if a disallowed operator is found in unquoted context.
 */
function tokenizeShell(command: string): { segments: string[]; error: string | null } {
  const segments: string[] = [];
  let current = "";
  let i = 0;

  const enum Quote {
    None,
    Single,
    Double,
  }
  let quote: Quote = Quote.None;

  while (i < command.length) {
    const ch = command[i];

    // Inside single quotes: everything is literal until closing '
    if (quote === Quote.Single) {
      if (ch === "'") {
        quote = Quote.None;
      }
      current += ch;
      i++;
      continue;
    }

    // Inside double quotes: literal except for backslash escapes
    if (quote === Quote.Double) {
      if (ch === "\\") {
        current += ch;
        i++;
        if (i < command.length) {
          current += command[i];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        quote = Quote.None;
      }
      current += ch;
      i++;
      continue;
    }

    // Unquoted context — operators are meaningful here

    // Backslash escape
    if (ch === "\\") {
      current += ch;
      i++;
      if (i < command.length) {
        current += command[i];
        i++;
      }
      continue;
    }

    // Enter quotes
    if (ch === "'") {
      quote = Quote.Single;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quote = Quote.Double;
      current += ch;
      i++;
      continue;
    }

    // Backtick — always disallowed
    if (ch === "`") {
      return { segments: [], error: "Error: command contains disallowed shell operator (backticks)" };
    }

    // $( — command substitution
    if (ch === "$" && i + 1 < command.length && command[i + 1] === "(") {
      return { segments: [], error: "Error: command contains disallowed shell operator ($())" };
    }

    // Semicolon
    if (ch === ";") {
      return { segments: [], error: "Error: command contains disallowed shell operator (;)" };
    }

    // && or ||
    if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
      return { segments: [], error: "Error: command contains disallowed shell operator (&&)" };
    }
    if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
      return { segments: [], error: "Error: command contains disallowed shell operator (||)" };
    }

    // I/O redirects: >, >>, <, <<, fd redirects like 2>, 2>>, 2>&1, >&, <&
    // Check for fd-prefix redirects (e.g. 2> or 2>>)
    if (/\d/.test(ch)) {
      const rest = command.slice(i);
      const fdMatch = rest.match(/^\d+([><])/);
      if (fdMatch) {
        return { segments: [], error: "Error: command contains disallowed redirect operator" };
      }
    }
    if (ch === ">" || ch === "<") {
      return { segments: [], error: "Error: command contains disallowed redirect operator" };
    }

    // & — background operator (also catches the first char of && but && is caught above)
    if (ch === "&") {
      return { segments: [], error: "Error: command contains disallowed shell operator (&)" };
    }

    // Pipe — split into new segment
    if (ch === "|") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (quote !== Quote.None) {
    return { segments: [], error: "Error: command contains unterminated quote" };
  }

  segments.push(current);
  return { segments, error: null };
}

/**
 * Extract the binary name from a pipeline segment, handling:
 * - Leading whitespace
 * - VAR=value env prefixes (skipped)
 * - Quoted binary names (quotes stripped)
 */
function extractBinary(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "";

  // Quote-aware split into tokens (only need enough to find argv[0])
  const tokens: string[] = [];
  let tok = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        tok += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tok) {
        tokens.push(tok);
        tok = "";
      }
      continue;
    }
    tok += ch;
  }
  if (tok) tokens.push(tok);

  // Skip VAR=value prefixes
  let idx = 0;
  while (idx < tokens.length && /^\w+=/.test(tokens[idx])) {
    idx++;
  }

  if (idx >= tokens.length) return "";
  return basename(tokens[idx]);
}

function validateCommand(command: string): string | null {
  const { segments, error } = tokenizeShell(command);
  if (error) return error;

  for (const segment of segments) {
    const bin = extractBinary(segment);
    if (!bin) continue;
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
