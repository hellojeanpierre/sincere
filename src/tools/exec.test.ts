import { describe, test, expect } from "bun:test";
import { execTool } from "./exec.ts";

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
