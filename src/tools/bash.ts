import { basename } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Subprocess } from "bun";
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

export function validateCommand(command: string): string | null {
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

// -- Persistent shell session types --

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  wasReset: boolean;
}

type Waiter = () => void;

export function bashTool(sessionDir: string, opts?: { timeoutMs?: number }): AgentTool<typeof bashSchema> {
  let dirReady = false;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  // -- Persistent shell session state --
  let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let stdoutBuf = "";
  let stderrBuf = "";
  let wasReset = false;
  let waiters: Waiter[] = [];

  function notifyWaiters() {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  }

  function startReaders(p: Subprocess<"pipe", "pipe", "pipe">) {
    const decoder = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array>, target: "stdout" | "stderr") => {
      try {
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true });
          if (target === "stdout") stdoutBuf += text;
          else stderrBuf += text;
          notifyWaiters();
        }
      } catch {
        // Stream closed — shell died
      }
      notifyWaiters();
    };
    drain(p.stdout as unknown as ReadableStream<Uint8Array>, "stdout");
    drain(p.stderr as unknown as ReadableStream<Uint8Array>, "stderr");
  }

  function spawn() {
    proc = Bun.spawn(["bash", "--norc", "--noprofile"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    stdoutBuf = "";
    stderrBuf = "";
    startReaders(proc);
  }

  function isAlive(): boolean {
    return proc !== null && proc.exitCode === null;
  }

  function kill() {
    if (proc) {
      wasReset = true;
      if (proc.exitCode === null) proc.kill();
    }
    proc = null;
    stdoutBuf = "";
    stderrBuf = "";
  }

  function extractBetweenMarkers(
    buf: string,
    beginMarker: string,
    exitPrefix: string,
  ): { content: string; exitCode: number; endIdx: number } | null {
    const beginIdx = buf.indexOf(beginMarker);
    if (beginIdx === -1) return null;

    const exitIdx = buf.indexOf(exitPrefix, beginIdx);
    if (exitIdx === -1) return null;

    const exitLineEnd = buf.indexOf("\n", exitIdx);
    const exitLine = buf.slice(exitIdx, exitLineEnd === -1 ? undefined : exitLineEnd);

    // Parse exit code: __SENTINEL_EXIT_<uuid>_<code>__
    const codeStr = exitLine.slice(exitPrefix.length, exitLine.length - 2); // strip trailing __
    const exitCode = parseInt(codeStr, 10);

    // Content is between the begin marker line end and the exit marker
    const contentStart = buf.indexOf("\n", beginIdx);
    if (contentStart === -1) return null;
    const content = buf.slice(contentStart + 1, exitIdx);

    // Strip trailing newline from content (the echo '' before sentinel adds one)
    const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;

    return { content: trimmed, exitCode, endIdx: exitLineEnd === -1 ? buf.length : exitLineEnd + 1 };
  }

  function waitForSentinels(
    uuid: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const beginMarker = `__SENTINEL_BEGIN_${uuid}__`;
    const exitPrefix = `__SENTINEL_EXIT_${uuid}_`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove our waiter so it doesn't fire after timeout
        waiters = waiters.filter((w) => w !== check);
        logger.info({ uuid, timeoutMs: timeout }, "bash session timeout, killing shell");
        kill();
        reject(new Error("timeout"));
      }, timeout);

      const check = () => {
        const stdoutResult = extractBetweenMarkers(stdoutBuf, beginMarker, exitPrefix);
        const stderrResult = extractBetweenMarkers(stderrBuf, beginMarker, exitPrefix);

        if (stdoutResult && stderrResult) {
          clearTimeout(timer);
          // Trim consumed regions from buffers
          stdoutBuf = stdoutBuf.slice(stdoutResult.endIdx);
          stderrBuf = stderrBuf.slice(stderrResult.endIdx);
          resolve({
            stdout: stdoutResult.content,
            stderr: stderrResult.content,
            exitCode: stdoutResult.exitCode,
          });
          return;
        }

        // Not ready yet — re-register waiter
        waiters.push(check);
      };

      check();
    });
  }

  async function run(command: string): Promise<RunResult> {
    if (!isAlive()) spawn();

    const resetNotice = wasReset;
    wasReset = false;

    const uuid = crypto.randomUUID();
    const ecVar = `__ec_${uuid.replace(/-/g, "_")}`;
    const beginMarker = `__SENTINEL_BEGIN_${uuid}__`;
    const exitSentinel = `__SENTINEL_EXIT_${uuid}_`;

    const script = [
      `echo '${beginMarker}'`,
      `echo '${beginMarker}' >&2`,
      command,
      `${ecVar}=$?`,
      `echo ''`,
      `echo '${exitSentinel}'"\${${ecVar}}"'__'`,
      `echo '${exitSentinel}'"\${${ecVar}}"'__' >&2`,
    ].join("\n") + "\n";

    proc!.stdin.write(script);
    proc!.stdin.flush();

    const result = await waitForSentinels(uuid, timeoutMs);

    return { ...result, wasReset: resetNotice };
  }

  // -- Tool definition --

  return {
    name: "bash",
    label: "Execute Command",
    description: `Run a shell command in the project working directory and return stdout/stderr. Only allowlisted read-only binaries are permitted: grep, awk, sed, jq, wc, cat, head, tail, sort, uniq, cut, tr, python3. No shell chaining (;, &&, ||), no redirects (>, >>), no command substitution ($(), backticks). ${Math.round(timeoutMs / 1000)}-second timeout. Output over 25,000 chars is truncated to a 2,000-char preview. Full output is persisted to ${sessionDir}/{toolCallId}.txt. Shell session persists across calls — env vars, cwd, and functions are retained. If the session is killed (timeout or crash), a fresh shell is spawned automatically.`,
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

      let result: RunResult;
      try {
        result = await run(params.command);
      } catch (err) {
        if (err instanceof Error && err.message === "timeout") {
          const durationMs = Math.round(performance.now() - start);
          logger.info({ command: params.command, durationMs }, "bash timeout");
          return {
            content: [{ type: "text", text: `Error: command timed out after ${Math.round(timeoutMs / 1000)}s` }],
            details: null,
          };
        }
        throw err;
      }

      const durationMs = Math.round(performance.now() - start);

      let text = result.stdout;
      if (result.stderr) {
        text += text ? `\n[stderr]\n${result.stderr}` : `[stderr]\n${result.stderr}`;
      }
      if (!text) {
        text = "(no output)";
      }

      if (result.wasReset) {
        text = "[Shell session was reset. Previous variables and state are lost.]\n" + text;
      }

      logger.info({ command: params.command, exitCode: result.exitCode, durationMs }, "bash command");

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
            details: { command: params.command, exitCode: result.exitCode, durationMs },
          };
        } catch (err) {
          logger.error({ toolCallId, err }, "bash output persistence failed");
          return {
            content: [{ type: "text", text: preview + `\n\n[Full output lost — persistence failed]` }],
            details: { command: params.command, exitCode: result.exitCode, durationMs },
          };
        }
      }

      return {
        content: [{ type: "text", text }],
        details: { command: params.command, exitCode: result.exitCode, durationMs },
      };
    },
  };
}
