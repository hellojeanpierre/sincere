import { basename } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const bashSchema = Type.Object({
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

const MAX_OUTPUT = 25_000;
const PREVIEW_LIMIT = 2_000;

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

interface RunResult {
  stdout: string;
  exitCode: number;
}

function createBashSession() {
  type Proc = ReturnType<typeof Bun.spawn>;
  let proc: Proc | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let buf = "";
  const decoder = new TextDecoder();

  // Serialize session.run() calls so only one command is in flight at a time.
  let lock: Promise<void> = Promise.resolve();

  function spawn() {
    buf = "";
    proc = Bun.spawn(["bash", "--norc", "--noprofile"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    // Drain stderr to prevent backpressure — we merge per-command via 2>&1.
    new Response(proc.stderr).text().catch(() => {});
  }

  function alive(): boolean {
    return proc !== null && proc.exitCode === null;
  }

  async function run(command: string, timeout: number): Promise<RunResult> {
    let unlock!: () => void;
    const prev = lock;
    lock = new Promise<void>(r => { unlock = r; });
    await prev;

    try {
      if (!alive()) spawn();

      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const sentinel = `__SINCERE_${id}__`;

      const wrapped = `{ ${command}\n} 2>&1\necho "${sentinel} $?"\n`;
      proc!.stdin.write(wrapped);
      proc!.stdin.flush();

      const deadline = Date.now() + timeout;

      while (true) {
        const sentinelIdx = buf.indexOf(sentinel);
        if (sentinelIdx !== -1) {
          const stdout = buf.slice(0, sentinelIdx);
          const afterSentinel = buf.slice(sentinelIdx + sentinel.length);
          const newlineIdx = afterSentinel.indexOf("\n");
          const exitStr = afterSentinel.slice(0, newlineIdx !== -1 ? newlineIdx : undefined).trim();
          const exitCode = parseInt(exitStr, 10) || 0;
          buf = newlineIdx !== -1 ? afterSentinel.slice(newlineIdx + 1) : "";
          return { stdout, exitCode };
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          proc!.kill();
          proc = null;
          reader = null;
          buf = "";
          throw new Error("timeout");
        }

        const chunk = await Promise.race([
          reader!.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), remaining),
          ),
        ]);

        if (chunk.done) {
          proc = null;
          reader = null;
          buf = "";
          throw new Error("session died");
        }

        buf += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      unlock();
    }
  }

  return {
    get alive() { return alive(); },
    run,
    dispose() {
      if (reader) {
        reader.cancel().catch(() => {});
        reader = null;
      }
      if (proc) {
        proc.kill();
        proc = null;
      }
      buf = "";
    },
  };
}

export interface BashToolResult {
  tool: AgentTool<typeof bashSchema>;
  dispose: () => void;
  injectEnv: (key: string, value: string) => void;
}

export function bashTool(sessionDir: string): BashToolResult {
  let dirReady = false;
  const session = createBashSession();

  const tool: AgentTool<typeof bashSchema> = {
    name: "bash",
    label: "Execute Command",
    description: `Run a shell command in the project working directory and return stdout/stderr. Only allowlisted read-only binaries are permitted: grep, awk, sed, jq, wc, cat, head, tail, sort, uniq, cut, tr, python3. No shell chaining (;, &&, ||), no redirects (>, >>), no command substitution ($(), backticks). 30-second timeout. Output over 25,000 chars is truncated to a 2,000-char preview. Full output is persisted to ${sessionDir}/{toolCallId}.txt.`,
    parameters: bashSchema,
    async execute(toolCallId, params) {
      const error = validateCommand(params.command);
      if (error) {
        return {
          content: [{ type: "text", text: error }],
          details: null,
        };
      }

      const start = performance.now();

      let stdout: string;
      let exitCode: number;
      try {
        const result = await session.run(params.command, 30_000);
        stdout = result.stdout;
        exitCode = result.exitCode;
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        if ((err as Error).message === "timeout") {
          logger.info({ command: params.command, durationMs }, "bash timeout");
          return {
            content: [{ type: "text", text: `Error: command timed out after 30s` }],
            details: null,
          };
        }
        logger.error({ command: params.command, err }, "bash session error");
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          details: null,
        };
      }

      const durationMs = Math.round(performance.now() - start);
      const text = stdout || "(no output)";

      logger.info({ command: params.command, exitCode, durationMs }, "bash command");

      if (text.length > MAX_OUTPUT) {
        const safeId = toolCallId ? toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_") : String(Date.now());
        const lastNewline = text.lastIndexOf("\n", PREVIEW_LIMIT);
        const preview = text.slice(0, lastNewline > 0 ? lastNewline : PREVIEW_LIMIT);
        const path = `${sessionDir}/${safeId}.txt`;

        try {
          if (!dirReady) {
            await mkdir(sessionDir, { recursive: true });
            dirReady = true;
          }
          await writeFile(path, text);
          logger.info({ toolCallId, command: params.command, chars: text.length, path }, "bash output truncated and persisted");
          return {
            content: [{ type: "text", text: preview + `\n\n[Full output persisted to ${path} — use read tool to access]` }],
            details: { command: params.command, exitCode, durationMs },
          };
        } catch (err) {
          logger.error({ toolCallId, err }, "bash output persistence failed");
          return {
            content: [{ type: "text", text: preview + `\n\n[Full output lost — persistence failed]` }],
            details: { command: params.command, exitCode, durationMs },
          };
        }
      }

      return {
        content: [{ type: "text", text }],
        details: { command: params.command, exitCode, durationMs },
      };
    },
  };

  return {
    tool,
    dispose: () => session.dispose(),
    injectEnv(key: string, value: string) {
      if (!session.alive) return;
      session.run(`export ${key}=${shellEscape(value)}`, 5_000).catch(() => {});
    },
  };
}
