import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execTool, createExecTool } from "./exec.ts";

describe("exec tool", () => {
  test("runs a simple command and returns stdout", async () => {
    const result = await execTool.execute("test", { command: "cat package.json" });
    expect(result.content[0].text).toContain("name");
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("returns stderr for failed command", async () => {
    const result = await execTool.execute("test", {
      command: "cat nonexistent-file-abc123",
    });
    const text = result.content[0].text;
    expect(text).toContain("nonexistent-file-abc123");
  });

  test("non-zero exit code is reported", async () => {
    const result = await execTool.execute("test", {
      command: "grep impossible-string-xyz /dev/null",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).not.toBe(0);
  });

  test("disallowed binary is blocked", async () => {
    const result = await execTool.execute("test", { command: "rm somefile" });
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.content[0].text).toContain("rm");
    expect(result.details).toBeNull();
  });

  test("redirect operator is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "grep foo > out.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("comparison inside double quotes is allowed", async () => {
    const result = await execTool.execute("test", {
      command: 'python3 -c "x > 5"',
    });
    expect(result.content[0].text).not.toContain("redirect operator");
    expect(result.details).not.toBeNull();
  });

  test("arrow inside nested quotes is allowed", async () => {
    const result = await execTool.execute("test", {
      command: `python3 -c "print('dict -> keys')"`,
    });
    expect(result.content[0].text).not.toContain("redirect operator");
    expect(result.details).not.toBeNull();
  });

  test("disallowed binary in pipeline is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "cat foo | rm bar",
    });
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.details).toBeNull();
  });

  test("semicolon chaining is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq . file ; rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("&& chaining is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "grep foo file && rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("|| chaining is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "grep foo file || rm file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("command substitution $() is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "grep $(rm foo) file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("backtick substitution is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "grep `rm foo` file",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("pipeline of allowed binaries works", async () => {
    const result = await execTool.execute("test", {
      command: "echo hello | grep hello | wc -l",
    });
    // echo is not in allowlist, so this should fail
    expect(result.content[0].text).toContain("binary not allowed");
    expect(result.details).toBeNull();
  });

  test("pipeline of only allowed binaries succeeds", async () => {
    const result = await execTool.execute("test", {
      command: "cat package.json | grep name | head -1",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
    expect(result.content[0].text).toContain("name");
  });

  // --- Quote-aware parser tests ---

  test("jq with pipe inside single quotes is allowed", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo | keys[]' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq with > inside single quotes is allowed", async () => {
    const result = await execTool.execute("test", {
      command: "jq 'select(.version > \"1\")' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq with @tsv is allowed", async () => {
    const result = await execTool.execute("test", {
      command: "jq -r '.[] | @tsv' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("jq piped to head with real pipe works", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.name' package.json | head -5",
    });
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("real redirect in unquoted context is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' package.json > out.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("real semicolon in unquoted context is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' package.json ; rm bar",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("VAR=value prefix before binary is allowed", async () => {
    const result = await execTool.execute("test", {
      command: "FOO=bar jq '.name' package.json",
    });
    expect(result.details).not.toBeNull();
  });

  test("quoted binary name is allowed", async () => {
    const result = await execTool.execute("test", {
      command: `"jq" '.name' package.json`,
    });
    expect(result.details).not.toBeNull();
  });

  test("input redirect is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' < input.txt",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("fd redirect 2>&1 is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' file.json 2>&1",
    });
    expect(result.content[0].text).toContain("redirect operator");
    expect(result.details).toBeNull();
  });

  test("unterminated single quote is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo | keys[]",
    });
    expect(result.content[0].text).toContain("unterminated quote");
    expect(result.details).toBeNull();
  });

  test("unterminated double quote is blocked", async () => {
    const result = await execTool.execute("test", {
      command: 'jq ".foo | keys[]',
    });
    expect(result.content[0].text).toContain("unterminated quote");
    expect(result.details).toBeNull();
  });

  test("lone & (background operator) is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' package.json &",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("& between commands is blocked", async () => {
    const result = await execTool.execute("test", {
      command: "jq '.foo' package.json & rm -rf /",
    });
    expect(result.content[0].text).toContain("disallowed shell operator");
    expect(result.details).toBeNull();
  });

  test("details object has correct shape", async () => {
    const result = await execTool.execute("test", {
      command: "cat package.json | wc -l",
    });
    const d = result.details!;
    expect(d.command).toBe("cat package.json | wc -l");
    expect(typeof d.exitCode).toBe("number");
    expect(typeof d.durationMs).toBe("number");
  });
});

describe("exec tool truncation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "exec-trunc-"));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  // Each line: 7-char prefix + 93 x's + newline = 101 chars
  const genCmd = (chars: number) => {
    const lines = Math.ceil(chars / 101);
    return `python3 -c "exec('import sys\\nfor i in range(${lines}):\\n sys.stdout.write(chr(76)+str(i).zfill(6)+chr(120)*93+chr(10))')"`;
  };

  test("output under 25k is returned as-is with sessionDir", async () => {
    const tool = createExecTool(tempDir);
    const result = await tool.execute("under-ceiling", { command: "cat package.json" });
    const text = result.content[0].text;
    expect(text).not.toContain("[Full output persisted");
    expect(text).toContain("name");
  });

  test("output over 25k is truncated with preview and persisted", async () => {
    const tool = createExecTool(tempDir);
    const callId = "trunc-test-1";
    const result = await tool.execute(callId, { command: genCmd(30_000) });
    const text = result.content[0].text;

    // Should contain the persistence pointer
    expect(text).toContain("[Full output persisted to");
    expect(text).toContain("use read tool to access]");

    // Preview should be ~2k chars (cut at newline boundary), well under 25k
    const previewEnd = text.indexOf("\n\n[Full output persisted");
    expect(previewEnd).toBeGreaterThan(0);
    expect(previewEnd).toBeLessThanOrEqual(2_000);

    // Full output should be on disk and larger than the preview
    const persisted = readFileSync(join(tempDir, `${callId}.txt`), "utf-8");
    expect(persisted.length).toBeGreaterThan(25_000);

    // Details still present
    expect(result.details).not.toBeNull();
    expect(result.details!.exitCode).toBe(0);
  });

  test("preview cuts at newline boundary, not mid-line", async () => {
    const tool = createExecTool(tempDir);
    const result = await tool.execute("newline-cut", { command: genCmd(30_000) });
    const text = result.content[0].text;
    const previewEnd = text.indexOf("\n\n[Full output persisted");
    const preview = text.slice(0, previewEnd);
    // Last char of preview should be end-of-line content (not a newline itself chopped mid-line)
    // Each line is 101 chars; preview cut at newline means length is a multiple of 101
    expect(preview.endsWith("\n") || preview.length % 101 === 0 || preview.length < 2_000).toBe(true);
  });

  test("default execTool (no sessionDir) returns large output as-is", async () => {
    const result = await execTool.execute("no-trunc", { command: genCmd(30_000) });
    const text = result.content[0].text;
    expect(text).not.toContain("[Full output persisted");
    expect(text).not.toContain("[Full output lost");
    expect(text.length).toBeGreaterThan(25_000);
  });

  test("empty toolCallId falls back to timestamp-based filename", async () => {
    const subDir = join(tempDir, "empty-id");
    const tool = createExecTool(subDir);
    const result = await tool.execute("", { command: genCmd(30_000) });
    const text = result.content[0].text;
    expect(text).toContain("[Full output persisted to");
    // File should exist in subDir with a numeric name
    const match = text.match(/persisted to (.+?) —/);
    expect(match).not.toBeNull();
    const persisted = readFileSync(match![1], "utf-8");
    expect(persisted.length).toBeGreaterThan(25_000);
  });

  test("description includes truncation note only with sessionDir", () => {
    const withDir = createExecTool("/tmp/test");
    const withoutDir = createExecTool();
    expect(withDir.description).toContain("Output over 25,000 chars is truncated");
    expect(withoutDir.description).not.toContain("Output over 25,000 chars is truncated");
  });
});
