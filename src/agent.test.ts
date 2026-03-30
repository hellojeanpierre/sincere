import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { makeTransformContext, loadSystemPrompt } from "./agent.ts";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const TEST_DIR = resolve(import.meta.dirname, "..", "data/test-tool-results");
const transformContext = makeTransformContext(TEST_DIR);

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
  describe("age counter direction", () => {
    test("older messages get higher age values with 10+ user turns", async () => {
      const messages: AgentMessage[] = [];
      for (let turn = 0; turn < 12; turn++) {
        messages.push(userMsg(`question ${turn}`));
        messages.push(assistantMsg(`thinking ${turn}`));
        messages.push(toolResult("read", `result ${turn}`));
      }

      const result = await transformContext(messages);

      const firstResult = result[2];
      expect(firstResult.role).toBe("toolResult");
      if (firstResult.role === "toolResult") {
        const text = firstResult.content[0];
        expect(text.type).toBe("text");
        if (text.type === "text") {
          expect(text.text).toContain("[stale result:");
          expect(text.text).toContain("11 turns ago");
        }
      }

      const lastResult = result[35];
      expect(lastResult.role).toBe("toolResult");
      if (lastResult.role === "toolResult") {
        const text = lastResult.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("result 11");
        }
      }
    });

    test("messages in recent 3 turns are never pruned", async () => {
      const messages: AgentMessage[] = [];
      for (let turn = 0; turn < 5; turn++) {
        messages.push(userMsg(`q ${turn}`));
        messages.push(assistantMsg(`a ${turn}`));
        messages.push(toolResult("read", `result ${turn}`));
      }

      const result = await transformContext(messages);

      for (let turn = 0; turn < 5; turn++) {
        const tr = result[turn * 3 + 2];
        if (tr.role === "toolResult") {
          const text = tr.content[0];
          if (text.type === "text") {
            expect(text.text).toBe(`result ${turn}`);
          }
        }
      }
    });
  });

  describe("microcompaction", () => {
    test("preserves non-text content blocks when microcompacting", async () => {
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } };
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(11000), { extraContent: [imageBlock] }),
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
      const fullText = "x".repeat(12000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", fullText),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("x".repeat(2000));
          expect(text.text).toContain("[Full output persisted to");
          expect(text.text.length).toBeLessThan(2200);
        }
      }
    });

    test("persisted file contains full original text", async () => {
      const callId = "tc_persist_check_" + Date.now();
      const fullText = "y".repeat(12000);
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
      const failCtx = makeTransformContext("/dev/null/impossible/path");
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", "z".repeat(15000)),
      ];

      const result = await failCtx(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text.length).toBeLessThan(2200);
          expect(text.text).toContain("z".repeat(2000));
          expect(text.text).toContain("[Full output lost");
        }
      }
    });

    test("results under 10k fall through to age-based logic", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(5000)),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("[read: 5000 chars]");
        }
      }
    });
  });

  describe("error passthrough", () => {
    test("never reshapes error results regardless of size", async () => {
      const bigError = "E".repeat(5000);
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

    test("never prunes stale error results", async () => {
      const messages: AgentMessage[] = [];
      for (let turn = 0; turn < 12; turn++) {
        messages.push(userMsg(`q ${turn}`));
        messages.push(assistantMsg(`a ${turn}`));
      }
      messages.splice(1, 0, toolResult("exec", "old error", { isError: true }));

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("old error");
        }
      }
    });
  });

  describe("age-aware exec threshold", () => {
    test("fresh exec (age 1) under 10k passes through unchanged", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", "x".repeat(5000)),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("x".repeat(5000));
        }
      }
    });

    test("fresh exec (age 1) over 10k gets microcompacted", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("exec", "x".repeat(12000)),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("[Full output persisted to");
          expect(text.text.length).toBeLessThan(2200);
        }
      }
    });

    test("older exec (age 3) truncates at 3k threshold", async () => {
      // 3 user messages after the exec result → age 3
      const messages: AgentMessage[] = [
        userMsg("q0"),
        toolResult("exec", "x".repeat(5000)),
        userMsg("q1"),
        assistantMsg("a1"),
        userMsg("q2"),
        assistantMsg("a2"),
        userMsg("q3"),
        assistantMsg("a3"),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("[exec: 5000 chars]");
        }
      }
    });

    test("fresh read (age 1) still truncates at 3k threshold", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(5000)),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain("[read: 5000 chars]");
        }
      }
    });

    test("exec at boundary age 2 still gets 10k budget", async () => {
      // 2 user messages after the exec result → age 2 (boundary of <= 2)
      const messages: AgentMessage[] = [
        userMsg("q0"),
        toolResult("exec", "x".repeat(5000)),
        userMsg("q1"),
        assistantMsg("a1"),
      ];
      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("x".repeat(5000));
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
