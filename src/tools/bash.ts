import { basename } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const bashSchema = Type.Object({
  command: Type.String(),
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
  // Shell builtins — safe, needed for persistent session state management.
  "export",
  "cd",
  "echo",
  "pwd",
  // python3 is a full escape hatch — it can import os, subprocess, etc.
  // This is accepted risk: we need it for computation and trust the Operator
  // prompt to use it safely. The guard is defence-in-depth, not a sandbox.
  "python3",
]);

// Operators checked via startsWith in the main loop. Longest match first
// so e.g. && is tested before &. Pipe is handled separately (splits segments).
// Redirects are handled separately (digit-prefix regex doesn't fit this pattern).
const DISALLOWED_OPS = [
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

    // && — allowed operator, splits segments (each side has its own binary)
    if (command.startsWith("&&", i)) {
      operators.push("&&");
      pushSegment();
      i += 2;
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

const MAX_OUTPUT = 100_000;
const HEAD_SIZE = 50_000;
const TAIL_SIZE = 50_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STDERR_FLUSH_DELAY_MS = 50;
const POLL_INTERVAL_MS = 100;

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  reset: boolean;
}

// Shell state (cwd, env vars, functions) intentionally persists across commands
// within a work item session. This is the core behavioral change vs the old
// per-call Bun.spawn approach.
class BashSession {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stdoutStr = "";
  private stderrStr = "";
  private dead = false;
  private stdoutDone = false;
  private stderrDone = false;
  private pumpDonePromise: Promise<void> = Promise.resolve();
  private resetOccurred = false;
  // Readers stored so teardown() can cancel them immediately, unblocking any
  // pending read() even if a child process holds the pipe open.
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Single-flight lock: serializes run() calls and ensures kill() does not
  // overlap with in-flight text assembly (post-sentinel) in _run().
  private lock: Promise<void> = Promise.resolve();
  readonly sentinel: string;
  private readonly sentinelRe: RegExp;

  constructor() {
    this.sentinel = `__BASH_SENTINEL_${crypto.randomUUID().replace(/-/g, "")}__`;
    // No leading \n — zero-stdout commands have sentinel at buffer position 0.
    // Trailing \n prevents a premature match while exit-code digits are still in flight.
    this.sentinelRe = new RegExp(`${this.sentinel}(\\d+)\n`);
  }

  // Advance the lock past p regardless of whether p resolves or rejects.
  // The empty rejection handler is intentional — the lock must move forward
  // even when run() throws, so a subsequent kill() or run() is not blocked.
  private advance(p: Promise<unknown>): void {
    this.lock = p.then(() => {}, () => {});
  }

  get alive(): boolean {
    return this.proc !== null && !this.dead;
  }

  private ensureStarted() {
    if (this.proc !== null) return;
    this.dead = false;
    this.stdoutDone = false;
    this.stderrDone = false;
    this.stdoutStr = "";
    this.stderrStr = "";

    const proc = Bun.spawn(["bash", "--norc", "--noprofile"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    this.proc = proc;

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    this.stdoutReader = stdoutReader;
    this.stderrReader = stderrReader;

    const pumpStdout = async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          this.stdoutStr += stdoutDecoder.decode(value, { stream: true });
        }
      } catch {
        // Reader was cancelled by teardown() — exit pump cleanly.
      } finally {
        this.stdoutDone = true;
        this.dead = true;
        this.resetOccurred = true;
        // Null proc so ensureStarted() re-spawns after unexpected process death.
        if (this.proc === proc) this.proc = null;
      }
    };

    const pumpStderr = async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          this.stderrStr += stderrDecoder.decode(value, { stream: true });
        }
      } catch {
        // Reader was cancelled by teardown() — exit pump cleanly.
      } finally {
        this.stderrDone = true;
      }
    };

    this.pumpDonePromise = Promise.all([pumpStdout(), pumpStderr()]).then(() => {});
  }

  private async teardown() {
    // Cancel readers first. This unblocks any pending read() immediately,
    // even if a child process (e.g. python3 spawned by bash) holds the pipe
    // open — which SIGTERM/SIGKILL alone cannot fix.
    this.stdoutReader?.cancel();
    this.stderrReader?.cancel();
    this.stdoutReader = null;
    this.stderrReader = null;

    const proc = this.proc;
    if (proc !== null) {
      proc.kill(); // SIGTERM
      this.proc = null;
    }

    // Pumps exit as soon as their readers are cancelled (next microtask).
    // Race against 2s deadline + SIGKILL as belt-and-suspenders for any
    // process trapping SIGTERM.
    const deadline = new Promise<void>(resolve => setTimeout(resolve, 2000));
    await Promise.race([this.pumpDonePromise, deadline]);
    if (!this.stdoutDone || !this.stderrDone) {
      proc?.kill(9); // SIGKILL
      await this.pumpDonePromise;
    }

    this.stdoutStr = "";
    this.stderrStr = "";
    this.resetOccurred = true;
  }

  // Snapshot current buffers and return a failed ShellResult without calling teardown().
  // Always call teardown() after this.
  private partialResult(stderrMark: number, timedOut: boolean): ShellResult {
    return { stdout: this.stdoutStr, stderr: this.stderrStr.slice(stderrMark), exitCode: -1, timedOut, reset: true };
  }

  private async _run(command: string, timeoutMs: number): Promise<ShellResult> {
    const wasReset = this.resetOccurred;
    this.resetOccurred = false;

    this.ensureStarted();

    const stderrMark = this.stderrStr.length;

    // Write command framed with sentinel. The ; is load-bearing: it ensures
    // echo runs regardless of command exit code. Using && would make $? always 0.
    const frame = `${command}\necho "${this.sentinel}$?"\n`;
    try {
      this.proc!.stdin.write(frame);
      this.proc!.stdin.flush();
    } catch {
      // Process died between ensureStarted() and write — tear down and report.
      await this.teardown();
      return { stdout: "", stderr: "", exitCode: -1, timedOut: false, reset: true };
    }

    const deadline = Date.now() + timeoutMs;

    while (true) {
      const match = this.sentinelRe.exec(this.stdoutStr);
      if (match) {
        const stdout = this.stdoutStr.slice(0, match.index);
        const exitCode = parseInt(match[1], 10);
        // Advance buffer past the matched sentinel line.
        this.stdoutStr = this.stdoutStr.slice(match.index + match[0].length);

        // 50ms delay to let stderr flush — known imprecision, matches the reference
        // implementation. Trade-off: simple vs. sentinel-framing stderr separately.
        await Bun.sleep(STDERR_FLUSH_DELAY_MS);
        const stderr = this.stderrStr.slice(stderrMark);
        // Trim only the consumed region. Late-arriving stderr may bleed into
        // the next command's window — acceptable vs. silent loss from a full clear.
        this.stderrStr = this.stderrStr.slice(stderrMark + stderr.length);

        return { stdout, stderr, exitCode, timedOut: false, reset: wasReset };
      }

      if (this.dead) {
        const result = this.partialResult(stderrMark, false);
        await this.teardown();
        return result;
      }

      if (Date.now() > deadline) {
        const result = this.partialResult(stderrMark, true);
        await this.teardown();
        return result;
      }

      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  run(command: string, timeoutMs: number): Promise<ShellResult> {
    // Single-flight: chain onto lock so concurrent calls serialize.
    const result = this.lock.then(() => this._run(command, timeoutMs));
    this.advance(result);
    return result;
  }

  kill(): Promise<void> {
    // Signal the poll loop to exit at its next iteration (~POLL_INTERVAL_MS)
    // instead of waiting up to the full command timeout. Still chains on the
    // lock so teardown does not race with post-sentinel text assembly in _run().
    this.dead = true;
    const done = this.lock.then(() => this.teardown());
    this.advance(done);
    return done;
  }
}

export interface BashToolResult {
  tool: AgentTool<typeof bashSchema>;
  dispose: () => Promise<void>;
  setLastResult: (path: string) => void;
}

export function bashTool(sessionDir: string, timeoutMs = COMMAND_TIMEOUT_MS): BashToolResult {
  let dirReady = false;
  const session = new BashSession();

  const tool: AgentTool<typeof bashSchema> = {
    name: "bash",
    label: "Execute Command",
    description: `Run a shell command in the project working directory and return stdout/stderr. The shell session is persistent — variables, files, and working directory survive across calls. Use && to chain dependent commands and | for pipelines. Only allowlisted binaries: grep, awk, sed, jq, wc, cat, head, tail, sort, uniq, cut, tr, python3. No other shell chaining (;, ||), no redirects (>, >>), no command substitution ($(), backticks). ${timeoutMs / 1000}-second timeout. Output over ${MAX_OUTPUT} chars is truncated to first ${HEAD_SIZE} + last ${TAIL_SIZE} chars; full output persisted to ${sessionDir}/{toolCallId}.txt.`,
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
      const { stdout, stderr, exitCode, timedOut, reset } = await session.run(params.command, timeoutMs);
      const durationMs = Math.round(performance.now() - start);

      // Build prefix notice. Timeout and session death also carry partial output
      // captured before the failure — more useful to the agent than nothing.
      let prefixNotice = "";
      if (timedOut) {
        logger.info({ command: params.command, durationMs }, "bash timeout");
        prefixNotice = `[Timed out after ${timeoutMs / 1000}s — shell state has been reset.]\n`;
      } else if (exitCode === -1) {
        logger.info({ command: params.command, durationMs }, "bash shell session died");
        prefixNotice = `[Shell session died unexpectedly — state has been reset.]\n`;
      } else if (reset) {
        prefixNotice = `[Shell session was reset. Previous variables and state are lost.]\n`;
      }

      let text = prefixNotice + stdout;
      if (stderr) {
        text += text.trimEnd() ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
      }
      if (!text) {
        text = "(no output)";
      }

      // Timeout and session death always return details: null regardless of partial output.
      if (timedOut || exitCode === -1) {
        return {
          content: [{ type: "text", text }],
          details: null,
        };
      }

      logger.info({ command: params.command, exitCode, durationMs }, "bash command");

      if (text.length > MAX_OUTPUT) {
        const safeId = toolCallId ? toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_") : String(Date.now());
        const path = `${sessionDir}/${safeId}.txt`;

        // Both snaps go inward (head backward, tail forward) to keep only
        // complete lines and maximise the omitted region.
        const headBreak = text.lastIndexOf("\n", HEAD_SIZE);
        const head = text.slice(0, headBreak > 0 ? headBreak : HEAD_SIZE);

        const tailStart = text.indexOf("\n", text.length - TAIL_SIZE);
        const tail = text.slice(tailStart >= 0 ? tailStart + 1 : text.length - TAIL_SIZE);

        const omitted = Math.max(0, text.length - head.length - tail.length);
        const notice = `\n\n[... truncated ${omitted} characters — full output persisted to ${path} — use read tool to access]\n\n`;
        const preview = head + notice + tail;

        try {
          if (!dirReady) {
            await mkdir(sessionDir, { recursive: true });
            dirReady = true;
          }
          await writeFile(path, text);
          logger.info({ toolCallId, command: params.command, chars: text.length, path }, "bash output truncated and persisted");
          return {
            content: [{ type: "text", text: preview }],
            details: { command: params.command, exitCode, durationMs },
          };
        } catch (err) {
          logger.error({ toolCallId, err }, "bash output persistence failed");
          return {
            content: [{ type: "text", text: head + `\n\n[... truncated ${omitted} characters — full output lost — persistence failed]\n\n` + tail }],
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
    dispose: () => session.kill(),
    // Best-effort: sets $LAST_RESULT in the live shell so the agent's next
    // bash call can reference the persisted file directly. Ordering is
    // guaranteed by the session lock — session.run() chains synchronously
    // onto the lock, so the export always serializes before the next
    // tool.execute() call. Silent no-op if the session is dead; the
    // truncated preview already contains the path as a fallback.
    setLastResult(path: string) {
      if (!session.alive) return;
      session.run(`export LAST_RESULT=${shellEscape(path)}`, 5_000).catch(() => {});
    },
  };
}
