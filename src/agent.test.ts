import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { makeTransformContext, loadSystemPrompt } from "./agent.ts";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const TEST_DIR = resolve(import.meta.dirname, "..", "data/test-tool-results");
const TEST_HINT_DIR = "data/sessions/latest/tool-results";
const transformContext = makeTransformContext(TEST_DIR, TEST_HINT_DIR);

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

function toolResult(toolName: string, text: string, opts?: { isError?: boolean; extraContent?: any[]; toolCallId?: string }): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: opts?.toolCallId ?? "tc_" + Math.random().toString(36).slice(2),
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

    test("preserves non-text content blocks when microcompacting", async () => {
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } };
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(11_000), { extraContent: [imageBlock] }),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        expect(tr.content.length).toBe(2);
        expect(tr.content[0].type).toBe("text");
        expect(tr.content[1].type).toBe("image");
      }
    });

    test("microcompaction persists full text and keeps 2k preview", async () => {
      const fullText = "x".repeat(12_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", fullText),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("x".repeat(2_000));
          expect(text.text).toContain("[Full output persisted to data/sessions/latest/tool-results/");
          expect(text.text.length).toBeLessThan(2_200);
        }
      }
    });

    test("persisted file contains full original text", async () => {
      const callId = "tc_persist_check_" + Date.now();
      const fullText = "y".repeat(12_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", fullText, { toolCallId: callId }),
      ];

      await transformContext(messages);

      const filePath = resolve(TEST_DIR, `${callId}.txt`);
      expect(existsSync(filePath)).toBe(true);
      const written = readFileSync(filePath, "utf-8");
      expect(written).toBe(fullText);
    });

    test("write failure still truncates to preview", async () => {
      const failCtx = makeTransformContext("/dev/null/impossible/path", "data/sessions/latest/tool-results");
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", "z".repeat(15_000)),
      ];

      const result = await failCtx(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text.length).toBeLessThan(2_200);
          expect(text.text).toContain("z".repeat(2_000));
          expect(text.text).toContain("[Full output lost");
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
