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

// Operators checked via startsWith in the main loop. Longest match first
// so e.g. && is tested before &. Pipe is handled separately (splits segments).
// Redirects are handled separately (digit-prefix regex doesn't fit this pattern).
const DISALLOWED_OPS = [
  { match: "&&", name: "&&" },
  { match: "||", name: "||" },
  { match: "$(", name: "$()" },
  { match: "`", name: "backticks" },
  { match: ";", name: ";" },
  { match: "&", name: "&" },
] as const;

const DISALLOWED_OP_NAMES = new Set(DISALLOWED_OPS.map((op) => op.name));

interface Segment {
  raw: string;
  binary: string;
}

interface TokenizeResult {
  segments: Segment[];
  operators: string[];
}

/**
 * Quote-aware shell tokenizer. Walks the command string character-by-character,
 * tracking quote context to distinguish real shell operators from characters
 * inside quoted arguments. Extracts the binary name (argv[0]) per segment
 * inline — skipping VAR=value prefixes and stripping surrounding quotes.
 *
 * Returns pipe-delimited segments with their binary names, plus a list of
 * all operators found in unquoted context. Does not reject anything itself —
 * validation is the caller's job.
 */
function tokenizeShell(command: string): TokenizeResult | string {
  const segments: Segment[] = [];
  const operators: string[] = [];
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

    // Table-driven operator detection (longest match first)
    let matched = false;
    for (const op of DISALLOWED_OPS) {
      if (command.startsWith(op.match, i)) {
        operators.push(op.name);
        i += op.match.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Pipe — split into new segment
    if (ch === "|") {
      operators.push("|");
      pushSegment();
      i++;
      continue;
    }

    // I/O redirects: >, >>, <, <<, fd redirects like 2>, 2>>, 2>&1, >&, <&
    if (/\d/.test(ch)) {
      const rest = command.slice(i);
      const fdMatch = rest.match(/^\d+([><])/);
      if (fdMatch) {
        operators.push("redirect");
        i += fdMatch[0].length;
        continue;
      }
    }
    if (ch === ">" || ch === "<") {
      operators.push("redirect");
      i++;
      continue;
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

    token += ch;
    current += ch;
    i++;
  }

  if (quote !== Quote.None) {
    return "Error: command contains unterminated quote";
  }

  pushSegment();
  return { segments, operators };
}

function validateCommand(command: string): string | null {
  const result = tokenizeShell(command);
  if (typeof result === "string") return result;

  const { segments, operators } = result;

  for (const op of operators) {
    if (DISALLOWED_OP_NAMES.has(op)) {
      return `Error: command contains disallowed shell operator (${op})`;
    }
    if (op === "redirect") {
      return "Error: command contains disallowed redirect operator";
    }
  }

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
