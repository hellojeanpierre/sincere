import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "path";
import { loadSystemPrompt } from "../../src/operator.ts";

// --- Config ---
const SRC_DIR = process.argv[2] || "./src";
const MODEL = process.env.MODEL || "claude-haiku-4-5-20251001";

const systemPrompt = loadSystemPrompt(resolve(SRC_DIR));
const client = new Anthropic();

// --- Tool definition matching src/tools/read.ts schema ---
const readToolDef: Anthropic.Tool = {
  name: "read",
  description:
    "Read a UTF-8 text file from disk. Returns file contents with line-based pagination. " +
    "Supports .md, .json, .jsonl, .csv, .txt, .html and similar text formats. " +
    "Output is truncated to 2000 lines or 50KB, whichever is hit first. Use offset and limit for large files.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "File path relative to project root, or absolute" },
      offset: { type: "number", description: "Line number to start from (0-based). Default: 0" },
      limit: { type: "number", description: "Max lines to return. Default: 2000" },
    },
    required: ["path"],
  },
};

// --- Test cases ---
type Case = { prompt: string; expectedSkill: string };

const cases: Case[] = [
  // data-analysis: clear
  {
    prompt: "Analyze the resolution rate data in data/pintest-v2 to find root causes for underperformance",
    expectedSkill: "data-analysis",
  },
  {
    prompt: "Load the ticket dataset and find patterns explaining the 12% failure rate",
    expectedSkill: "data-analysis",
  },
  {
    prompt: "Investigate what's driving the gap in resolution metrics across BPO partners",
    expectedSkill: "data-analysis",
  },
  // data-analysis: near-boundary
  {
    prompt: "Look at the case data to understand why certain ticket cohorts have worse outcomes",
    expectedSkill: "data-analysis",
  },
  {
    prompt: "Examine the structured data to figure out what's going wrong with resolution rates",
    expectedSkill: "data-analysis",
  },
  // case-transition-watch: clear
  {
    prompt: "The agent is closing this case. The customer reported a billing overcharge on their last invoice. The agent sent a password-reset walkthrough 4 minutes ago.",
    expectedSkill: "case-transition-watch",
  },
  {
    prompt: "This case is being marked resolved. The customer asked for a refund on a canceled order. The agent applied a loyalty discount instead and closed without confirming.",
    expectedSkill: "case-transition-watch",
  },
  {
    prompt: "The agent is escalating this ticket to tier 2. The customer's issue is a simple DNS configuration that tier 1 handles routinely. The case has been open for 90 seconds.",
    expectedSkill: "case-transition-watch",
  },
  // case-transition-watch: near-boundary
  {
    prompt: "This case just transitioned to solved. The customer described a problem connecting to WiFi after a firmware update. The agent walked them through a factory reset and the customer confirmed it's working.",
    expectedSkill: "case-transition-watch",
  },
  {
    prompt: "The agent is closing this ticket. The metadata says 'billing inquiry' but the customer's messages are about a missing delivery. The agent responded with a billing FAQ link.",
    expectedSkill: "case-transition-watch",
  },
];

// --- Skill file paths (used to match tool_use read targets) ---
const SKILL_FILES: Record<string, string> = {
  "data-analysis": "skills/data-analysis.md",
  "case-transition-watch": "skills/case-transition-watch.md",
};

const SKILL_NAMES = Object.keys(SKILL_FILES);

function extractReadPaths(response: Anthropic.Message): string[] {
  return response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "read")
    .map((b) => (b.input as { path: string }).path);
}

function pathMatchesSkill(readPaths: string[], skill: string): boolean {
  const target = SKILL_FILES[skill];
  const filename = target.split("/").pop()!;
  return readPaths.some((p) => p === target || p.endsWith(`/${filename}`));
}

function skillsRead(readPaths: string[]): string[] {
  return SKILL_NAMES.filter((s) => pathMatchesSkill(readPaths, s));
}

// --- Run ---
type CaseResult = {
  prompt: string;
  expectedSkill: string;
  readPaths: string[];
  skillsRead: string[];
  pass: boolean;
};

async function main() {
  console.log(`Model:   ${MODEL}`);
  console.log(`Prompt:  ${systemPrompt.length} chars`);
  console.log(`Cases:   ${cases.length}\n`);

  const results: CaseResult[] = [];

  for (const c of cases) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [readToolDef],
      messages: [{ role: "user", content: c.prompt }],
    });

    const readPaths = extractReadPaths(response);
    const matched = skillsRead(readPaths);
    const pass = matched.includes(c.expectedSkill);

    results.push({
      prompt: c.prompt,
      expectedSkill: c.expectedSkill,
      readPaths,
      skillsRead: matched,
      pass,
    });

    const mark = pass ? "✓" : "✗";
    const readInfo = readPaths.length ? readPaths.join(", ") : "(no read)";
    process.stdout.write(`  ${mark} [${c.expectedSkill}] ${c.prompt.slice(0, 60)}…  → ${readInfo}\n`);
  }

  // --- Metrics ---
  const accuracy = results.filter((r) => r.pass).length / results.length;
  const mutuallyExclusive = results.filter((r) => r.skillsRead.length === 1).length;
  const mutualExclusionRate = mutuallyExclusive / results.length;

  const output = {
    model: MODEL,
    cases: results,
    accuracy,
    mutualExclusionRate,
  };

  console.log(`\nAccuracy:             ${(accuracy * 100).toFixed(1)}%`);
  console.log(`Mutual-exclusion:     ${(mutualExclusionRate * 100).toFixed(1)}%`);

  const misses = results.filter((r) => !r.pass);
  if (misses.length) {
    console.log(`\nMisses (${misses.length}):`);
    for (const m of misses) {
      console.log(`  [${m.expectedSkill}] ${m.prompt.slice(0, 70)} → read: ${m.readPaths.join(", ") || "(none)"}`);
    }
  }

  console.log(`\n${JSON.stringify(output, null, 2)}`);
}

main().catch(console.error);
