import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { globSync } from "fs";
import { resolve } from "path";

// --- Config ---
const DATASET_PATH = process.argv[2] || "./data/tickets.jsonl";
const SRC_DIR = process.argv[3] || "./src";
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";
const RUNS_PER_CASE = Number(process.env.RUNS) || 1;

// Eval-only output constraint — not part of the skill
const EVAL_SUFFIX = `

Assess this case. Respond with exactly this JSON and nothing else:
{"verdict": "close" | "hold", "rationale": "<one sentence naming the specific gap, or 'clean' if none>"}`;

// --- Load system prompt the way the agent does ---
function loadSystemPrompt(srcDir: string): string {
  const operatorPath = resolve(srcDir, "operator.md");
  const operatorPrompt = existsSync(operatorPath)
    ? readFileSync(operatorPath, "utf-8")
    : "";
  const skillFiles = globSync(resolve(srcDir, "skills", "*.md"));
  const skills = skillFiles.map((f) => readFileSync(f, "utf-8")).join("\n\n");
  return skills ? `${operatorPrompt}\n\n${skills}` : operatorPrompt;
}

const systemPrompt = loadSystemPrompt(SRC_DIR);
const lines = readFileSync(DATASET_PATH, "utf-8").trim().split("\n");
const tickets = lines.map((l) => JSON.parse(l));
const client = new Anthropic();

// --- Types ---
type Verdict = "close" | "hold";
type Result = {
  id: string;
  expected: Verdict;
  got: Verdict[];
  rationales: string[];
  consistent: boolean;
  failure_mode: string;
};

function expectedVerdict(ticket: any): Verdict {
  const fm = ticket._ground_truth.failure_mode;
  return fm === "clean" || fm == null ? "close" : "hold";
}

function casePrompt(ticket: any): string {
  const { _ground_truth, ...caseData } = ticket;
  return JSON.stringify(caseData, null, 2) + EVAL_SUFFIX;
}

async function evaluate(ticket: any): Promise<{ verdict: Verdict; rationale: string }> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: "user", content: casePrompt(ticket) }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    // Strip any code fence (```json, ```python, etc.)
    let clean = text.replace(/```\w*\n?|```/g, "").trim();
    // If still not valid JSON, try extracting a JSON object
    if (!clean.startsWith("{")) {
      const match = clean.match(/\{[^}]*"verdict"\s*:[^}]*\}/);
      if (match) clean = match[0];
    }
    const parsed = JSON.parse(clean);
    return { verdict: parsed.verdict, rationale: parsed.rationale };
  } catch {
    console.error(`  ⚠ parse failed: ${text.slice(0, 120)}`);
    return { verdict: "close", rationale: "PARSE_ERROR" };
  }
}

async function main() {
  console.log(`Model:   ${MODEL}`);
  console.log(`Prompt:  ${systemPrompt.length} chars`);
  console.log(`Dataset: ${tickets.length} cases × ${RUNS_PER_CASE} runs\n`);

  const results: Result[] = [];
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const ticket of tickets) {
    const id = ticket.id || ticket.ticket_id || "?";
    const expected = expectedVerdict(ticket);
    const failureMode = ticket._ground_truth.failure_mode;
    const verdicts: Verdict[] = [];
    const rationales: string[] = [];

    for (let r = 0; r < RUNS_PER_CASE; r++) {
      const { verdict, rationale } = await evaluate(ticket);
      verdicts.push(verdict);
      rationales.push(rationale);
    }

    const holdCount = verdicts.filter((v) => v === "hold").length;
    const finalVerdict: Verdict = holdCount > RUNS_PER_CASE / 2 ? "hold" : "close";
    const consistent = new Set(verdicts).size === 1;

    if (finalVerdict === "hold" && expected === "hold") tp++;
    else if (finalVerdict === "hold" && expected === "close") fp++;
    else if (finalVerdict === "close" && expected === "close") tn++;
    else fn++;

    results.push({ id, expected, got: verdicts, rationales, consistent, failure_mode: failureMode });

    const mark = finalVerdict === expected ? "✓" : "✗";
    const tag = consistent ? "" : " [flip]";
    process.stdout.write(`  ${mark} ${id}: expected=${expected} got=${finalVerdict}${tag}\n`);
  }

  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  console.log(`
         hold  close
  hold    ${String(tp).padStart(3)}    ${String(fn).padStart(3)}
  close   ${String(fp).padStart(3)}    ${String(tn).padStart(3)}

  Precision: ${(precision * 100).toFixed(1)}%
  Recall:    ${(recall * 100).toFixed(1)}%
  F1:        ${(f1 * 100).toFixed(1)}%
`);

  // --- Recall by failure mode ---
  const modes = new Map<string, { total: number; caught: number }>();
  for (const r of results) {
    if (!r.failure_mode || r.failure_mode === "clean") continue;
    const m = modes.get(r.failure_mode) || { total: 0, caught: 0 };
    m.total++;
    if (r.got[0] === "hold") m.caught++;
    modes.set(r.failure_mode, m);
  }
  console.log("Recall by failure mode:");
  for (const [mode, { total, caught }] of [...modes.entries()].sort((a, b) => a[1].caught / a[1].total - b[1].caught / b[1].total)) {
    const pct = ((caught / total) * 100).toFixed(0);
    console.log(`  ${mode.padEnd(28)} ${caught}/${total} (${pct}%)`);
  }

  // --- Misses ---
  const misses = results.filter((r) => r.got[0] !== r.expected);
  if (misses.length) {
    console.log(`\nMisses (${misses.length}):`);
    for (const m of misses) {
      console.log(`  ${m.id} [${m.failure_mode}]: expected=${m.expected} got=${m.got[0]} — ${m.rationales[0]}`);
    }
  }

  // --- Flips ---
  if (RUNS_PER_CASE > 1) {
    const flaky = results.filter((r) => !r.consistent);
    if (flaky.length) {
      console.log(`\nFlips (${flaky.length}):`);
      for (const f of flaky) {
        console.log(`  ${f.id} [${f.failure_mode}]: ${f.got.join(",")}`);
      }
    }
  }
}

main().catch(console.error);
