import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { makeTransformContext, loadSystemPrompt } from "./agent.ts";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

let tmpDir: string;
let transformContext: ReturnType<typeof makeTransformContext>;

beforeAll(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), "tc-test-"));
  transformContext = makeTransformContext(tmpDir);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "" as any,
    provider: "" as any,
    usage: { inputTokens: 0, outputTokens: 0 } as any,
    stopReason: "end_turn" as any,
    timestamp: Date.now(),
  };
}

function toolResult(toolName: string, text: string, opts?: { isError?: boolean; extraContent?: any[] }): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc_" + Math.random().toString(36).slice(2),
    toolName,
    content: [
      { type: "text" as const, text },
      ...(opts?.extraContent ?? []),
    ],
    isError: opts?.isError ?? false,
    timestamp: Date.now(),
  };
}

describe("transformContext", () => {
  describe("microcompaction", () => {
    test("results under 10k pass through unchanged", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(9_999)),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("x".repeat(9_999));
        }
      }
    });

    test("results over 10k get persisted to disk with 2k preview", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", "x".repeat(15_000)),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text.length).toBeLessThan(2_200); // 2k preview + pointer
          expect(text.text).toContain("[Full output persisted to");
          expect(text.text).toContain("use read tool to access]");
        }
      }

      // Verify file was written to disk
      const files = readdirSync(tmpDir).filter(f => f.endsWith(".txt"));
      expect(files.length).toBeGreaterThan(0);
      const written = readFileSync(resolve(tmpDir, files[files.length - 1]), "utf-8");
      expect(written).toBe("x".repeat(15_000));
    });

    test("preserves non-text content blocks during microcompaction", async () => {
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } };
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(12_000), { extraContent: [imageBlock] }),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        expect(tr.content.length).toBe(2);
        expect(tr.content[0].type).toBe("text");
        expect(tr.content[1].type).toBe("image");
      }
    });

    test("preview is first 2000 chars of joined text", async () => {
      const fullText = "A".repeat(2_000) + "B".repeat(10_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", fullText),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text.startsWith("A".repeat(2_000))).toBe(true);
          expect(text.text).not.toContain("B".repeat(100));
        }
      }
    });
  });

  describe("error passthrough", () => {
    test("never compacts error results regardless of size", async () => {
      const bigError = "E".repeat(15_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", bigError, { isError: true }),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe(bigError);
        }
      }
    });
  });
});

describe("loadSystemPrompt", () => {
  test("produces a non-empty prompt containing the operator section", () => {
    const prompt = loadSystemPrompt(resolve(import.meta.dirname, "operator.md"));
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("# Operator Prompt");
  });

  test("skill paths in system prompt resolve to existing files from project root", () => {
    const prompt = loadSystemPrompt(resolve(import.meta.dirname, "operator.md"));
    const skillPathPattern = /\*\*\w[\w-]*\*\* \(([^)]+)\):/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = skillPathPattern.exec(prompt)) !== null) {
      paths.push(match[1]);
    }
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const resolved = resolve(process.cwd(), p);
      expect(existsSync(resolved)).toBe(true);
    }
  });
});
