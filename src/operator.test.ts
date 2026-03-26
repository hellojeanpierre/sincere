import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import { transformContext, createAgent, loadSystemPrompt } from "./operator.ts";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

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
  describe("age counter direction", () => {
    test("older messages get higher age values with 10+ user turns", async () => {
      // Build a conversation with 12 user turns, each followed by an assistant + toolResult
      const messages: AgentMessage[] = [];
      for (let turn = 0; turn < 12; turn++) {
        messages.push(userMsg(`question ${turn}`));
        messages.push(assistantMsg(`thinking ${turn}`));
        messages.push(toolResult("read", `result ${turn}`));
      }

      const result = await transformContext(messages);

      // Turn 0's toolResult (index 2) should be stale (age 12 > 8)
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

      // Turn 11's toolResult (last, index 35) should be untouched (age 1)
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

      // All results should be untouched — max age is 5, under threshold of 8
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

  describe("reshaping large results", () => {
    test("preserves non-text content blocks", async () => {
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } };
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(4000), { extraContent: [imageBlock] }),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        // Should have the summary text block + the preserved image block
        expect(tr.content.length).toBe(2);
        expect(tr.content[0].type).toBe("text");
        expect(tr.content[1].type).toBe("image");
      }
    });

    test("preview takes first 300 + last 200 chars", async () => {
      const head = "H".repeat(300);
      const middle = "M".repeat(3000);
      const tail = "[Showing lines 0-99 of 500. Call read again with offset=100 to continue.]";
      const padded = tail.padStart(200, "T");
      const fullText = head + middle + padded;

      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", fullText),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toContain(head); // first 300
          expect(text.text).toContain("Call read again with offset=100"); // tail hint preserved
          expect(text.text).not.toContain("M".repeat(100)); // middle is dropped
        }
      }
    });

    test("does not reshape results under 3000 chars", async () => {
      const messages: AgentMessage[] = [
        userMsg("go"),
        toolResult("read", "x".repeat(2999)),
      ];

      const result = await transformContext(messages);
      const tr = result[1];
      if (tr.role === "toolResult") {
        const text = tr.content[0];
        if (text.type === "text") {
          expect(text.text).toBe("x".repeat(2999));
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
      // Insert an error result at the very beginning (after first user msg)
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
});

describe("createAgent system prompt", () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = savedKey || "test-key";
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  test("produces a non-empty prompt containing the operator section", () => {
    const agent = createAgent();
    const prompt = agent.state.systemPrompt;
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("# Operator Prompt");
  });

  test("skill paths in system prompt resolve to existing files from project root", () => {
    const srcDir = resolve(import.meta.dirname);
    const prompt = loadSystemPrompt(srcDir);
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
