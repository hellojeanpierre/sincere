import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashTool } from "./bash.ts";

const tmpDir = mkdtempSync(join(tmpdir(), "bash-test-"));
const { tool, dispose } = bashTool(tmpDir);
afterAll(async () => {
  await dispose();
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

  test("&& chaining is blocked", async () => {
    const result = await tool.execute("test", {
      command: "grep foo file && rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
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

  test("pipeline of allowed binaries works", async () => {
    const result = await tool.execute("test", {
      command: "echo hello | grep hello | wc -l",
    });
    // echo is not in allowlist, so this should fail
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.details).toBeNull();
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

  test("output over 25k is truncated with persistence", async () => {
    const result = await tool.execute("trunc-test", {
      command: `python3 -c "print('x' * 30000)"`,
    });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(3000);
    expect(text).toContain("[Full output persisted to");
    expect(text).toContain("use read tool to access]");
    // Verify file was written
    const path = join(tmpDir, "trunc-test.txt");
    const persisted = readFileSync(path, "utf-8");
    expect(persisted.length).toBe(30001); // 30000 x's + newline
    // Details still present
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("preview cuts at last newline before 2000 chars", async () => {
    // Generate lines of 100 chars each — newlines at 101, 202, 303, ...
    const result = await tool.execute("newline-test", {
      command: `python3 -c "exec('for i in range(300):\\n    print(chr(97) * 100)')"`,
    });
    const text = result.content[0].text;
    const previewEnd = text.indexOf("\n\n[Full output persisted");
    const preview = text.slice(0, previewEnd);
    // Each line is 101 chars (100 'a' + newline). lastIndexOf("\n", 2000)
    // finds the newline, slice(0, pos) excludes it, so the preview is
    // n complete lines minus the final newline: (n * 101) - 1.
    expect((preview.length + 1) % 101).toBe(0);
  });

  test("empty toolCallId falls back to Date.now()", async () => {
    const result = await tool.execute("", {
      command: `python3 -c "print('y' * 30000)"`,
    });
    const text = result.content[0].text;
    expect(text).toContain("[Full output persisted to");
    // File should exist with a numeric name
    expect(text).toMatch(/\/\d+\.txt/);
  });

  test("output under 25k is returned in full", async () => {
    const result = await tool.execute("small-test", {
      command: `python3 -c "print('z' * 1000)"`,
    });
    const text = result.content[0].text;
    expect(text).not.toContain("[Full output persisted");
    expect(text.length).toBe(1001); // 1000 z's + newline
  });

  test("description includes sessionDir and truncation note", () => {
    expect(tool.description).toContain(tmpDir);
    expect(tool.description).toContain("Output over 25,000 chars is truncated");
  });

  // --- Persistent session tests ---

  test("sequential commands share shell state", async () => {
    const { tool: t, dispose: d } = bashTool(tmpDir);
    try {
      // Write bash's PID (via python's os.getppid()) to a temp file in command 1.
      // Re-read and verify it matches in command 2. Only passes if both commands
      // run in the same bash process — separate sessions have different bash PIDs.
      await t.execute("state-1", { command: `python3 -c "import os; open('/tmp/_bash_session_test', 'w').write(str(os.getppid()))"` });
      const result = await t.execute("state-2", { command: `python3 -c "import os; saved = open('/tmp/_bash_session_test').read(); cur = str(os.getppid()); print('ok' if saved == cur else 'mismatch: ' + saved + ' vs ' + cur)"` });
      expect(result.content[0].text).toContain("ok");
      expect(result.details).not.toBeNull();
    } finally {
      await d();
    }
  });

  test("timeout returns partial output and reset notice surfaces on next command", async () => {
    // Use a 1s timeout so the test doesn't take 30s.
    const { tool: t, dispose: d } = bashTool(tmpDir, 1_000);
    try {
      // Send a command that prints then hangs — partial output must survive the timeout.
      const result = await t.execute("hang", { command: `python3 -u -c "import time; print('partial'); time.sleep(60)"` });
      expect(result.details).toBeNull();
      expect(result.content[0].text).toContain("Timed out");
      expect(result.content[0].text).toContain("partial");
      // Session respawns on next call; reset notice surfaces on the first result.
      const after = await t.execute("after", { command: "cat package.json" });
      expect(after.content[0].text).toContain("Shell session was reset");
      expect(after.details).not.toBeNull();
    } finally {
      await d();
    }
  }, { timeout: 15_000 });

  test("dispose kills process cleanly and is idempotent", async () => {
    const { tool: t, dispose: d } = bashTool(tmpDir);
    // Start the session.
    await t.execute("disp-1", { command: "cat package.json" });
    // First dispose.
    await d();
    // Second dispose should not throw.
    await expect(d()).resolves.toBeUndefined();
  });
});
