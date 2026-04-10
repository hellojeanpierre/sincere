import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashTool } from "./bash.ts";

const tmpDir = mkdtempSync(join(tmpdir(), "bash-test-"));
const bash = bashTool(tmpDir);
const { tool } = bash;
afterAll(async () => {
  await bash.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bash tool", () => {
  test("runs a simple command and returns stdout", async () => {
    const result = await tool.execute("test", { command: "cat package.json" });
    expect(result.content[0].text).toContain("name");
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("returns stderr for failed command", async () => {
    const result = await tool.execute("test", {
      command: "cat nonexistent-file-abc123",
    });
    const text = result.content[0].text;
    expect(text).toContain("nonexistent-file-abc123");
  });

  test("non-zero exit code is reported", async () => {
    const result = await tool.execute("test", {
      command: "grep impossible-string-xyz /dev/null",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).not.toBe(0);
  });

  test("disallowed binary is blocked", async () => {
    const result = await tool.execute("test", { command: "rm somefile" });
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.content[0].text).toContain("rm");
    expect(result.details).toBeNull();
  });

  test("redirect operator is blocked", async () => {
    const result = await tool.execute("test", {
      command: "grep foo > out.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("comparison inside double quotes is allowed", async () => {
    const result = await tool.execute("test", {
      command: 'python3 -c "x > 5"',
    });
    expect(result.content[0].text).not.toContain("redirect operator");
    expect(result.details).not.toBeNull();
  });

  test("arrow inside nested quotes is allowed", async () => {
    const result = await tool.execute("test", {
      command: `python3 -c "print('dict -> keys')"`,
    });
    expect(result.content[0].text).not.toContain("redirect operator");
    expect(result.details).not.toBeNull();
  });

  test("disallowed binary in pipeline is blocked", async () => {
    const result = await tool.execute("test", {
      command: "cat foo | rm bar",
    });
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.details).toBeNull();
  });

  test("semicolon chaining is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq . file ; rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("&& chaining is allowed", async () => {
    const result = await tool.execute("test", {
      command: "echo hello && echo world",
    });
    expect(result.content[0].text).toContain("hello");
    expect(result.content[0].text).toContain("world");
  });

  test("|| chaining is blocked", async () => {
    const result = await tool.execute("test", {
      command: "grep foo file || rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("command substitution $() is blocked", async () => {
    const result = await tool.execute("test", {
      command: "grep $(rm foo) file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("backtick substitution is blocked", async () => {
    const result = await tool.execute("test", {
      command: "grep `rm foo` file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("pipeline with disallowed binary is blocked", async () => {
    const result = await tool.execute("test", {
      command: "ls foo | grep hello | wc -l",
    });
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.details).toBeNull();
  });

  test("pipeline of echo | grep | wc succeeds", async () => {
    const result = await tool.execute("test", {
      command: "echo hello | grep hello | wc -l",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
    expect(result.content[0].text.trim()).toBe("1");
  });

  test("pipeline of only allowed binaries succeeds", async () => {
    const result = await tool.execute("test", {
      command: "cat package.json | grep name | head -1",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
    expect(result.content[0].text).toContain("name");
  });

  // --- Quote-aware parser tests ---

  test("jq with pipe inside single quotes is allowed", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo | keys[]' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq with > inside single quotes is allowed", async () => {
    const result = await tool.execute("test", {
      command: "jq 'select(.version > \"1\")' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq with @tsv is allowed", async () => {
    const result = await tool.execute("test", {
      command: "jq -r '.[] | @tsv' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq piped to head with real pipe works", async () => {
    const result = await tool.execute("test", {
      command: "jq '.name' package.json | head -5",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("real redirect in unquoted context is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' package.json > out.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("real semicolon in unquoted context is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' package.json ; rm bar",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("VAR=value prefix before binary is allowed", async () => {
    const result = await tool.execute("test", {
      command: "FOO=bar jq '.name' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("quoted binary name is allowed", async () => {
    const result = await tool.execute("test", {
      command: `"jq" '.name' package.json`,
    });
    expect(result.details).not.toBeNull();
  });

  test("input redirect is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' < input.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("fd redirect 2>&1 is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' file.json 2>&1",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("unterminated single quote is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo | keys[]",
    });
    expect(result.content[0].text).toContain("unterminated quote");
    expect(result.details).toBeNull();
  });

  test("unterminated double quote is blocked", async () => {
    const result = await tool.execute("test", {
      command: 'jq ".foo | keys[]',
    });
    expect(result.content[0].text).toContain("unterminated quote");
    expect(result.details).toBeNull();
  });

  test("lone & (background operator) is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' package.json &",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("& between commands is blocked", async () => {
    const result = await tool.execute("test", {
      command: "jq '.foo' package.json & rm -rf /",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("details object has correct shape", async () => {
    const result = await tool.execute("test", {
      command: "cat package.json | wc -l",
    });
    const d = result.details!;
    expect(d.command).toBe("cat package.json | wc -l");
    expect(typeof d.exitCode).toBe("number");
    expect(typeof d.durationMs).toBe("number");
  });

  // --- Truncation tests ---

  test("output over 100k is truncated with head+tail and persistence", async () => {
    // Generate 120,000 chars with no newlines: 'H' * 60000 then 'T' * 60000
    const result = await tool.execute("trunc-test", {
      command: `python3 -c "import sys; sys.stdout.write('H' * 60000 + 'T' * 60000)"`,
    });
    const text = result.content[0].text;
    // Head present
    expect(text.startsWith("H")).toBe(true);
    // Tail present
    expect(text.endsWith("T")).toBe(true);
    // Truncation notice in the middle
    expect(text).toContain("[... truncated");
    expect(text).toContain("use read tool to access]");
    // No newlines in input, so head and tail fall back to exact HEAD_SIZE / TAIL_SIZE
    const noticeStart = text.indexOf("\n\n[... truncated");
    const noticeEnd = text.indexOf("]\n\n", noticeStart) + 3;
    const head = text.slice(0, noticeStart);
    const tail = text.slice(noticeEnd);
    expect(head.length).toBe(50000);
    expect(tail.length).toBe(50000);
    // Verify file was written
    const path = join(tmpDir, "trunc-test.txt");
    const persisted = readFileSync(path, "utf-8");
    expect(persisted.length).toBe(120000);
    // Details still present
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("head and tail both break at newline boundaries", async () => {
    // Generate 1200 lines of 100 chars each = 121,200 chars (each line 101 with newline)
    const result = await tool.execute("newline-test", {
      command: `python3 -c "exec('for i in range(1200):\\n    print(chr(97) * 100)')"`,
    });
    const text = result.content[0].text;
    const noticeStart = text.indexOf("\n\n[... truncated");
    const noticeEnd = text.indexOf("]\n\n", noticeStart) + 3;
    const head = text.slice(0, noticeStart);
    const tail = text.slice(noticeEnd);
    // Head should end at a complete line boundary — (n * 101) - 1 chars
    expect((head.length + 1) % 101).toBe(0);
    // Tail should contain only complete lines — each line is 101 chars
    // (the tail includes the trailing newline of each line)
    expect(tail.length % 101).toBe(0);
  });

  test("empty toolCallId falls back to Date.now()", async () => {
    const result = await tool.execute("", {
      command: `python3 -c "import sys; sys.stdout.write('y' * 120000)"`,
    });
    const text = result.content[0].text;
    expect(text).toContain("[... truncated");
    // File should exist with a numeric name
    expect(text).toMatch(/\/\d+\.txt/);
  });

  test("leading newline does not produce empty head", async () => {
    // Output starts with \n followed by 120,000 x's
    const result = await tool.execute("leading-nl", {
      command: `python3 -c "import sys; sys.stdout.write('\\n' + 'x' * 120000)"`,
    });
    const text = result.content[0].text;
    const noticeStart = text.indexOf("\n\n[... truncated");
    const head = text.slice(0, noticeStart);
    // headBreak === 0 (\n at position 0) falls back to HEAD_SIZE, not empty
    expect(head.length).toBe(50000);
    expect(head.startsWith("\n")).toBe(true);
  });

  test("persistence failure returns head+tail with 'output lost'", async () => {
    // Point sessionDir at an impossible path so mkdir throws
    const failBash = bashTool("/dev/null/impossible");
    const failTool = failBash.tool;
    try {
      const result = await failTool.execute("fail-persist", {
        command: `python3 -c "import sys; sys.stdout.write('A' * 60000 + 'B' * 60000)"`,
      });
      const text = result.content[0].text;
      expect(text).toContain("output lost");
      expect(text).toContain("persistence failed");
      // Head and tail still present
      expect(text.startsWith("A")).toBe(true);
      expect(text.endsWith("B")).toBe(true);
    } finally {
      await failBash.dispose();
    }
  });

  test("output under 100k is returned in full", async () => {
    const result = await tool.execute("small-test", {
      command: `python3 -c "print('z' * 1000)"`,
    });
    const text = result.content[0].text;
    expect(text).not.toContain("[... truncated");
    expect(text.length).toBe(1001); // 1000 z's + newline
  });

  // --- Infrastructure contract tests ---

  test("stdout matching sentinel pattern is returned verbatim", async () => {
    const sentinel = "__BASH_SENTINEL_550e8400-e29b-41d4-a716-446655440000__";
    const result = await tool.execute("sentinel-test", {
      command: `python3 -c "print('${sentinel}')"`,
    });
    expect(result.content[0].text).toBe(sentinel + "\n");
    expect(result.details!.exitCode).toBe(0);
  });

  test("exact non-zero exit code is captured", async () => {
    const result = await tool.execute("exit-test", {
      command: 'python3 -c "import sys; sys.exit(42)"',
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(42);
  });

  test("stdout and stderr are merged with [stderr] separator", async () => {
    const result = await tool.execute("both-streams", {
      command: 'python3 -c "import sys; print(\'OUT\'); print(\'ERR\', file=sys.stderr)"',
    });
    const text = result.content[0].text;
    expect(text).toContain("OUT");
    expect(text).toContain("[stderr]");
    expect(text).toContain("ERR");
  });

  test("empty output returns (no output) sentinel", async () => {
    const result = await tool.execute("empty-test", {
      command: 'python3 -c "pass"',
    });
    expect(result.content[0].text).toBe("(no output)");
    expect(result.details!.exitCode).toBe(0);
  });

  test("description includes sessionDir and truncation note", () => {
    expect(tool.description).toContain(tmpDir);
    expect(tool.description).toContain("Output over 100000 chars is truncated");
  });

  // --- Persistent session tests ---

  test("sequential commands share shell state (PID)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bash-state-"));
    const marker = join(stateDir, "pid.txt");
    const { tool: t, dispose: d } = bashTool(tmpDir);
    try {
      // Write bash's PID (via python's os.getppid()) to a temp file in command 1.
      // Re-read and verify it matches in command 2. Only passes if both commands
      // run in the same bash process — separate sessions have different bash PIDs.
      await t.execute("state-1", { command: `python3 -c "import os; open('${marker}', 'w').write(str(os.getppid()))"` });
      const result = await t.execute("state-2", { command: `python3 -c "import os; saved = open('${marker}').read(); cur = str(os.getppid()); print('ok' if saved == cur else 'mismatch: ' + saved + ' vs ' + cur)"` });
      expect(result.content[0].text).toContain("ok");
      expect(result.details).not.toBeNull();
    } finally {
      await d();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("env var persists across calls", async () => {
    const { tool: t, dispose: d } = bashTool(tmpDir);
    try {
      await t.execute("env-1", { command: "export PERSIST_TEST=hello_persist" });
      const result = await t.execute("env-2", { command: "echo $PERSIST_TEST" });
      expect(result.content[0].text.trim()).toBe("hello_persist");
      expect(result.details!.exitCode).toBe(0);
    } finally {
      await d();
    }
  });

  test("cwd persists across calls", async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "bash-cwd-"));
    const { tool: t, dispose: d } = bashTool(tmpDir);
    try {
      await t.execute("cwd-1", { command: `cd ${cwdDir}` });
      const result = await t.execute("cwd-2", { command: "pwd" });
      // /tmp may resolve to /private/tmp on macOS
      expect(result.content[0].text.trim()).toMatch(new RegExp(`${cwdDir}$`));
      expect(result.details!.exitCode).toBe(0);
    } finally {
      await d();
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  // Shell function persistence is not testable through execute() — both
  // definition syntax (;, {}) and invocation (arbitrary function names)
  // are blocked by the command validator.

  test("timeout returns partial output and reset notice surfaces on next command", async () => {
    // Use a 1s timeout so the test doesn't take 30s.
    const { tool: t, dispose: d } = bashTool(tmpDir, 1_000);
    try {
      // Set shell state before the timeout so we can verify it's gone after respawn.
      await t.execute("setup", { command: `python3 -c "import os; os.environ['STATE_CHECK'] = 'alive'"` });

      // Send a command that prints then hangs — partial output must survive the timeout.
      const result = await t.execute("hang", { command: `python3 -u -c "import time; print('partial'); time.sleep(60)"` });
      expect(result.details).toBeNull();
      expect(result.content[0].text).toContain("Timed out");
      expect(result.content[0].text).toContain("partial");

      // Session respawns on next call; reset notice surfaces on the first result.
      const after = await t.execute("after", { command: `python3 -c "print('respawned')"` });
      expect(after.content[0].text).toContain("Shell session was reset");
      expect(after.details).not.toBeNull();

      // Prove state was actually lost — STATE_CHECK should be gone in the new shell.
      const stateCheck = await t.execute("verify", { command: `python3 -c "import os; print(os.environ.get('STATE_CHECK', 'empty'))"` });
      expect(stateCheck.content[0].text.trim()).toBe("empty");
    } finally {
      await d();
    }
  }, { timeout: 15_000 });

  test("dispose kills process cleanly and is idempotent", async () => {
    const { tool: t, dispose: d } = bashTool(tmpDir);
    // Start the session.
    await t.execute("disp-1", { command: `python3 -c "print('started')"` });
    // First dispose.
    await d();
    // Second dispose should not throw.
    await expect(d()).resolves.toBeUndefined();
  });

  // --- setLastResult tests ---

  test("setLastResult makes $LAST_RESULT visible in the next execute call", async () => {
    // Start the session, then set LAST_RESULT. The session lock serializes
    // the export before the subsequent execute — no sleep needed.
    await tool.execute("test", { command: "cat /dev/null" });
    bash.setLastResult("/tmp/test-result.txt");
    const result = await tool.execute("test", {
      command: `python3 -c "import os; print(os.environ.get('LAST_RESULT', 'MISSING'))"`,
    });
    expect(result.content[0].text).toContain("/tmp/test-result.txt");
  });

  test("setLastResult shell-escapes paths with single quotes", async () => {
    await tool.execute("test", { command: "cat /dev/null" });
    bash.setLastResult("/tmp/it's a path/result.txt");
    const result = await tool.execute("test", {
      command: `python3 -c "import os; print(os.environ.get('LAST_RESULT', 'MISSING'))"`,
    });
    expect(result.content[0].text).toContain("/tmp/it's a path/result.txt");
  });

  test("setLastResult after dispose is a silent no-op", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "bash-lr-"));
    const bash2 = bashTool(tmp2);
    await bash2.tool.execute("test", { command: "cat /dev/null" });
    await bash2.dispose();
    // Should not throw
    bash2.setLastResult("/some/path.txt");
    rmSync(tmp2, { recursive: true, force: true });
  });

  test("trailing newline in command does not kill the session", async () => {
    const { tool: t, dispose: d } = bashTool(tmpDir);
    try {
      const result = await t.execute("trailing-nl", {
        command: `python3 -c "print('hello')\n"`,
      });
      expect(result.details).not.toBeNull();
      expect(result.details!.exitCode).toBe(0);
      expect(result.content[0].text.trim()).toBe("hello");
      // Session must still be alive — run a follow-up command.
      const after = await t.execute("trailing-nl-2", {
        command: `python3 -c "print('still alive')"`,
      });
      expect(after.details).not.toBeNull();
      expect(after.details!.exitCode).toBe(0);
      expect(after.content[0].text.trim()).toBe("still alive");
    } finally {
      await d();
    }
  });

  test("$LAST_RESULT is absent after session death and respawn", async () => {
    const tmp3 = mkdtempSync(join(tmpdir(), "bash-lr-death-"));
    const bash3 = bashTool(tmp3);
    try {
      // Start session and inject LAST_RESULT
      await bash3.tool.execute("test", { command: "cat /dev/null" });
      bash3.setLastResult("/tmp/some-result.txt");
      // Kill the session before the export runs (or has any effect)
      await bash3.dispose();
      // Next execute respawns a fresh shell — LAST_RESULT must not carry over.
      // The reset notice ("Shell session was reset...") is prepended by the first
      // post-respawn command; account for it with toContain rather than toBe.
      const result = await bash3.tool.execute("test", {
        command: `python3 -c "import os; print(os.environ.get('LAST_RESULT', 'MISSING'))"`,
      });
      expect(result.content[0].text).toContain("MISSING");
      expect(result.content[0].text).not.toContain("/tmp/some-result.txt");
    } finally {
      await bash3.dispose();
      rmSync(tmp3, { recursive: true, force: true });
    }
  });
});
