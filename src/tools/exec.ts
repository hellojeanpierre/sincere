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

interface Segment {
  raw: string;
  binary: string;
}

/**
 * Quote-aware shell tokenizer. Walks the command string character-by-character,
 * tracking quote context to distinguish real shell operators from characters
 * inside quoted arguments. Extracts the binary name (argv[0]) per segment
 * inline — skipping VAR=value prefixes and stripping surrounding quotes.
 *
 * Returns pipe-delimited segments with their binary names, or an error string
 * if a disallowed operator is found in unquoted context.
 */
function tokenizeShell(command: string): { segments: Segment[]; error: string | null } {
  const segments: Segment[] = [];
  let current = "";
  // Per-segment binary extraction state: collects whitespace-delimited tokens
  // with quotes stripped, enough to find argv[0] after skipping VAR=value prefixes.
  let token = "";
  let tokens: string[] = [];
  let i = 0;

  const enum Quote {
    None,
    Single,
    Double,
  }
  let quote: Quote = Quote.None;

  function pushSegment() {
    if (token) tokens.push(token);
    // Skip VAR=value prefixes
    let idx = 0;
    while (idx < tokens.length && /^\w+=/.test(tokens[idx])) idx++;
    const bin = idx < tokens.length ? basename(tokens[idx]) : "";
    segments.push({ raw: current, binary: bin });
    current = "";
    token = "";
    tokens = [];
  }

  while (i < command.length) {
    const ch = command[i];

    // Inside single quotes: everything is literal until closing '
    if (quote === Quote.Single) {
      if (ch === "'") {
        quote = Quote.None;
      } else {
        token += ch;
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
          token += command[i];
          current += command[i];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        quote = Quote.None;
      } else {
        token += ch;
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
        token += command[i];
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

    // Whitespace — token boundary for binary extraction
    if (/\s/.test(ch)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      current += ch;
      i++;
      continue;
    }

    // Pipe — split into new segment
    if (ch === "|") {
      pushSegment();
      i++;
      continue;
    }

    token += ch;
    current += ch;
    i++;
  }

  if (quote !== Quote.None) {
    return { segments: [], error: "Error: command contains unterminated quote" };
  }

  pushSegment();
  return { segments, error: null };
}

function validateCommand(command: string): string | null {
  const { segments, error } = tokenizeShell(command);
  if (error) return error;

  for (const { binary } of segments) {
    if (!binary) continue;
    if (!ALLOWED_BINARIES.has(binary)) {
      return `Error: binary not allowed: ${binary}. Allowed: ${[...ALLOWED_BINARIES].join(", ")}`;
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
