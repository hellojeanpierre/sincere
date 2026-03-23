import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { loadSystemPrompt } from "./load-prompt.ts";

const tmpDir = resolve(import.meta.dirname, "../../.test-load-prompt");

describe("loadSystemPrompt", () => {
  beforeAll(() => {
    mkdirSync(resolve(tmpDir, "skills"), { recursive: true });
    writeFileSync(resolve(tmpDir, "operator.md"), "base prompt");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("concatenates skill files into the system prompt", () => {
    writeFileSync(resolve(tmpDir, "skills", "test-skill.md"), "# Test Skill\n\nDo the thing.");
    const prompt = loadSystemPrompt(tmpDir);
    expect(prompt).toContain("base prompt");
    expect(prompt).toContain("# Test Skill");
    expect(prompt).toContain("Do the thing.");
  });

  test("returns operator prompt unchanged when skills directory is empty", () => {
    const emptyDir = resolve(tmpDir, "empty");
    mkdirSync(resolve(emptyDir, "skills"), { recursive: true });
    writeFileSync(resolve(emptyDir, "operator.md"), "base prompt only");
    const prompt = loadSystemPrompt(emptyDir);
    expect(prompt).toBe("base prompt only");
  });
});
