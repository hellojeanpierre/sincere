import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { makeTransformContext, loadSystemPrompt } from "./agent.ts";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

const TEST_DIR = resolve(import.meta.dirname, "..", "data/test-tool-results");
const TEST_HINT_DIR = "data/sessions/latest/tool-results";

// Small context window so tests can easily trigger pressure.
// 1000 tokens * 4 chars/token = 4000 chars of headroom at 100%.
// At 80% threshold that's 800 tokens = 3200 chars before compaction fires.
const SMALL_CTX = 1000;

// Large context window — nothing triggers compaction at this size.
const LARGE_CTX = 1_000_000;

function makeCtx(contextWindow = SMALL_CTX, systemPrompt = "") {
  return makeTransformContext(TEST_DIR, TEST_HINT_DIR, contextWindow, systemPrompt);
}

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

// 11 turns of padding to push earlier messages outside the 10-turn protection zone.
// Each turn: user + assistant + toolResult (small text so padding itself doesn't
// dominate the char budget — the target message should be what pushes over pressure).
function protectionPadding(): AgentMessage[] {
  const pad: AgentMessage[] = [];
  for (let i = 0; i < 11; i++) {
    pad.push(userMsg(`p${i}`), assistantMsg(`a${i}`), toolResult("read", `r${i}`));
  }
  return pad;
}

describe("transformContext", () => {
  describe("pressure trigger", () => {
    test("below 80% pressure, nothing compacts", async () => {
      const ctx = makeCtx(LARGE_CTX);
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("read", "x".repeat(20_000)),
        ...protectionPadding(),
      ];
      const result = await ctx(messages);
      const tr = result[2];
      expect((tr as ToolResultMessage).content[0].text).toBe("x".repeat(20_000));
    });

    test("results are compacted under pressure", async () => {
      const ctx = makeCtx(SMALL_CTX);
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("bash", "x".repeat(5_000)),
        ...protectionPadding(),
      ];
      const result = await ctx(messages);
      const tr = result[2];
      const text = (tr as ToolResultMessage).content[0].text;
      expect(text).toContain("[Full output persisted to");
      expect(text.length).toBeLessThan(2_200);
    });

    test("small tool results are compacted when over pressure", async () => {
      // contextWindow = 100 tokens → threshold = 80 tokens = 320 chars.
      // 500-char result + ~75 chars padding easily exceeds 320.
      const ctx = makeCtx(100);
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("read", "x".repeat(500)),
        ...protectionPadding(),
      ];
      const result = await ctx(messages);
      const tr = result[2];
      const text = (tr as ToolResultMessage).content[0].text;
      expect(text).toContain("[Full output persisted to");
    });
  });

  describe("protection zone", () => {
    test("protection zone covers exactly last 10 turns", async () => {
      const ctx = makeCtx(SMALL_CTX);
      // Turn 0 (outside protection — 11th from end)
      const messages: AgentMessage[] = [
        userMsg("t0"), assistantMsg("a0"), toolResult("bash", "A".repeat(3_000)),
      ];
      // Turns 1-10 (protected — last 10 turns)
      for (let i = 1; i <= 10; i++) {
        messages.push(userMsg(`t${i}`), assistantMsg(`a${i}`), toolResult("bash", "B".repeat(3_000)));
      }

      const result = await ctx(messages);

      // Turn 0 result (idx 2) — outside protection, compacted
      const t0 = result[2];
      expect((t0 as ToolResultMessage).content[0].text).toContain("[Full output persisted to");

      // Turns 1-10 results — inside protection, untouched
      for (let i = 1; i <= 10; i++) {
        const idx = i * 3 + 2;
        const tr = result[idx];
        expect((tr as ToolResultMessage).content[0].text).toBe("B".repeat(3_000));
      }
    });
  });

  describe("compaction behavior", () => {
    test("compaction stops once pressure drops below threshold", async () => {
      // contextWindow = 2500 tokens → threshold = 2000 tokens = 8000 chars.
      // Two compactable 3000-char tool results outside protection zone.
      // Padding adds ~11*6 = ~66 chars. System prompt = 0.
      // Total before compaction: ~6066 chars. Wait, that's under 8000.
      // Need to calibrate: make the results bigger or the window smaller.
      // contextWindow = 1500 → threshold = 1200 tokens = 4800 chars.
      // Two 3000-char results + padding ~66 = ~6066 chars → over 4800.
      // Compacting first result saves ~3000-2100 = ~900 chars → ~5166 chars, still over.
      // Compacting second result saves ~900 more → ~4266, under 4800. Both compact.
      // Instead: contextWindow = 1800 → threshold = 1440 tokens = 5760 chars.
      // Two 3000-char results + padding ~66 = ~6066 → over 5760.
      // Compacting first saves ~900 → ~5166, under 5760. Only first compacts.
      const ctx = makeCtx(1800);
      const id1 = "tc_stop1_" + Date.now();
      const id2 = "tc_stop2_" + Date.now();
      const messages: AgentMessage[] = [
        userMsg("t0"), assistantMsg("a0"), toolResult("bash", "A".repeat(3_000), { toolCallId: id1 }),
        userMsg("t1"), assistantMsg("a1"), toolResult("bash", "B".repeat(3_000), { toolCallId: id2 }),
      ];
      // Add 10 turns of small padding for protection zone
      for (let i = 2; i <= 11; i++) {
        messages.push(userMsg(`t${i}`), assistantMsg(`a${i}`), toolResult("read", `r${i}`));
      }

      const result = await ctx(messages);

      // First result (idx 2) — compacted
      expect((result[2] as ToolResultMessage).content[0].text).toContain("[Full output persisted to");
      // Second result (idx 5) — pressure dropped, not compacted
      expect((result[5] as ToolResultMessage).content[0].text).toBe("B".repeat(3_000));
    });

    test("already-compacted results are skipped", async () => {
      const ctx = makeCtx(SMALL_CTX);
      const alreadyCompacted = toolResult("bash", "preview text\n\n[Full output persisted to data/sessions/latest/tool-results/old.txt — use read tool to access]");
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        alreadyCompacted,
        ...protectionPadding(),
      ];
      const result = await ctx(messages);
      // Should be unchanged — not re-compacted, no new file written
      expect((result[2] as ToolResultMessage).content[0].text).toBe(
        (alreadyCompacted as ToolResultMessage).content[0].text,
      );
    });

    test("preserves non-text content blocks when compacting", async () => {
      const ctx = makeCtx(SMALL_CTX);
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "abc" } };
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("read", "x".repeat(5_000), { extraContent: [imageBlock] }),
        ...protectionPadding(),
      ];

      const result = await ctx(messages);
      const content = (result[2] as ToolResultMessage).content;
      expect(content.length).toBe(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("image");
    });

    test("persisted file contains full original text", async () => {
      const ctx = makeCtx(SMALL_CTX);
      const callId = "tc_persist_check_" + Date.now();
      const fullText = "y".repeat(5_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("read", fullText, { toolCallId: callId }),
        ...protectionPadding(),
      ];

      await ctx(messages);

      const filePath = resolve(TEST_DIR, `${callId}.txt`);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe(fullText);
    });

    test("write failure still truncates to preview", async () => {
      const failCtx = makeTransformContext("/dev/null/impossible/path", TEST_HINT_DIR, SMALL_CTX, "");
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("bash", "z".repeat(5_000)),
        ...protectionPadding(),
      ];

      const result = await failCtx(messages);
      const text = (result[2] as ToolResultMessage).content[0].text;
      expect(text.length).toBeLessThan(2_200);
      expect(text).toContain("z".repeat(2_000));
      expect(text).toContain("[Full output lost");
    });
  });

  describe("error passthrough", () => {
    test("never compacts error results", async () => {
      const ctx = makeCtx(SMALL_CTX);
      const bigError = "E".repeat(5_000);
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("bash", bigError, { isError: true }),
        ...protectionPadding(),
      ];

      const result = await ctx(messages);
      expect((result[2] as ToolResultMessage).content[0].text).toBe(bigError);
    });
  });

  describe("setLastResult integration", () => {
    test("compaction calls setLastResult with absolute writePath", async () => {
      const calls: string[] = [];
      const setLastResult = (path: string) => { calls.push(path); };
      const ctx = makeTransformContext(TEST_DIR, TEST_HINT_DIR, SMALL_CTX, "", setLastResult);

      const callId = "tc_inject_" + Date.now();
      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("bash", "x".repeat(5_000), { toolCallId: callId }),
        ...protectionPadding(),
      ];

      await ctx(messages);

      expect(calls.length).toBe(1);
      expect(calls[0]).toBe(`${TEST_DIR}/${callId}.txt`);
    });

    test("setLastResult not called for protected results", async () => {
      const calls: string[] = [];
      const setLastResult = (path: string) => { calls.push(path); };
      const ctx = makeTransformContext(TEST_DIR, TEST_HINT_DIR, SMALL_CTX, "", setLastResult);

      // Only 3 turns — all inside protection zone
      const messages: AgentMessage[] = [
        userMsg("go"), assistantMsg("a"), toolResult("bash", "x".repeat(5_000)),
        userMsg("go2"), assistantMsg("a2"), toolResult("bash", "y".repeat(5_000)),
        userMsg("go3"), assistantMsg("a3"), toolResult("bash", "z".repeat(5_000)),
      ];

      await ctx(messages);
      expect(calls.length).toBe(0);
    });

    test("setLastResult not called when persistence fails", async () => {
      const calls: string[] = [];
      const setLastResult = (path: string) => { calls.push(path); };
      const ctx = makeTransformContext("/dev/null/impossible/path", TEST_HINT_DIR, SMALL_CTX, "", setLastResult);

      const messages: AgentMessage[] = [
        userMsg("go"),
        assistantMsg("calling"),
        toolResult("bash", "x".repeat(5_000)),
        ...protectionPadding(),
      ];

      await ctx(messages);
      expect(calls.length).toBe(0);
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
