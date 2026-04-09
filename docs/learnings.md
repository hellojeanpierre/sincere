# Learnings

## 2026-04-09 — T1 planning mode is contagious: plural index → batch frame → all data loaded

A 2-item skill index caused the model to enter a plural/batch planning frame ("files... and also data files"), absorbing data file reads into the same parallel call. A 1-item index triggered a singular/sequential frame ("file... then explore"), deferring 3 of 4 data files. This shifted the discovery-to-synthesis boundary by 3 turns and inflated synthesis from 2 turns (4,050 words) to 4 turns (5,626 words). The mechanism is probabilistic but strong — the model extends existing batches cheaply but rarely initiates them from a singular frame. Implication: T1 planning width shouldn't depend on incidental context like skill count; the system prompt or operator prompt should explicitly enumerate data file paths.

## 2026-04-02 — Grounding failure mode reduced re-narration by 43pp and fixed a factual error in finding evidence

Adding a one-line failure mode ("if a value matters enough to cite, it matters enough to verify") to the data-analysis skill shifted thinking-token allocation from 26/60/14 (new/re-eval/tool-replaceable) to 46/17/4 on the 32-ticket benchmark. The agent ran targeted verification queries instead of reconstructing data from memory. The biggest win was indirect: grounding drove a full policy read that discovered SOP-ADS-005, which the previous trace missed due to truncation — fixing a factually wrong finding. Implication: Evidentiary standards can shift model behavior from thinking-as-memory to thinking-as-reasoning without prescribing workflow steps.

## 2026-04-02 — The most important tool result for synthesis is typically the most distant

R3 (non-solved ticket dump, line 522) contained the densest per-ticket metadata and was the single most-referenced result during cohort formation — but by T7 (line 1653) it was 1,100 lines away. This is structural, not accidental: profiling and data-dump steps run early in investigation workflows, producing the broad results that later synthesis depends on. Every subsequent targeted query pushes the broad result further away. The benchmark avoided this by running fresh extraction scripts in Phase 2 that produced compact, nearby results for the reasoning that consumed them. Implication: Investigation workflows have an inherent context-distance problem where early broad results decay in accessibility precisely when they're needed most for synthesis.

## 2026-04-02 — Benchmark analytical steps can introduce errors that later steps silently correct 

The benchmark's deep-dive script filtered status != 'solved', capturing 13 tickets including 2 with status closed (4800017, 4800050) whose event trails show SOLVED → CLOSED transitions. This inflated the unsolved count from 11 to 13, producing the 59.4% (19/32) headline number. The findings doc reports 65.6% (21/32), meaning a later deduplication or metric-impact step corrected the error without flagging it. The Operator avoided this bug entirely — it correctly treated closed as resolved in its reasoning. Implication: Benchmark numbers from intermediate steps should not be treated as ground truth. Always trace which step produced the final number

## 2026-04-02 — Falsification checks improve finding quality but miscalibrate promotion thresholds

The Operator detected the benchmark's F3 (100k+ stuck at T1), F4 (content moderation), and F5 (ad account suspension) patterns in its thinking trace but chose not to promote them. F4 rejection was correct — three different failure mechanisms grouped by category label, not mechanism. F5 was folded into F1 as a compounding signal. F3 was suppressed because one 100k+ ticket was resolved (1/4 = counterexample). The benchmark promoted all three without falsification, including F4 which mixes a closed ticket with heterogeneous failures. Quality-adjusted, the finding gap is 1, not 2 — and the Operator produced a novel finding (ad_rejected misdiagnosis) the benchmark missed.
Implication: The gap is in cohort formation scope (early termination on residuals), not detection or falsification logic.

## 2026-03-31 — A persistent bash session eliminates ~40% of agent tool call token waste from state re-acquisition

The Operator's exec tool spawned a fresh sh -c per call, forcing the agent to re-read policy files, redefine helper functions, and re-query data on every invocation. Claude Code and Codex solve this identically: one persistent shell process per session, commands written to stdin with sentinel-framed output capture. Renaming exec → bash aligns with the API tool type (bash_20250124) and gives the model stronger priors on shell idioms. Implication: Constrain the environment (persistent process), don't instruct the reasoning (prompt-level caching hints).

## 2026-03-31 — Tool-level truncation outperforms context-layer compaction for agent reasoning

When truncation happens silently in transformContext, the agent cannot reason about it — the JSONL manifest destruction at age 0 was a direct consequence. Moving truncation to the tool boundary (matching Claude Code's read/exec tool descriptions) makes the constraint part of the tool contract: the agent sees it in the description, can plan around it (e.g., grep instead of cat), and the preview + disk-persist pointer is explicit, not surprising. Silent post-hoc compaction defeats upstream tool design intent. Implication: constrain the environment at the boundary the agent can see.

## 2026-03-31 — Hypothesis: semantic compaction markers trigger retrieval; mechanical path hints do not

Microcompaction markers like [Full output persisted to .../file.txt — use read tool] read as housekeeping. The agent doesn't retrieve because it doesn't know the persisted data is relevant to its current step — the how was never the bottleneck. Claude Code's microcompaction has the same pattern: path references that lose semantic content and can be dropped by downstream compaction. A content-descriptive marker like [Per-queue match rates (5 queues, 847 tickets) — .../file.txt] would turn the stub into a reasoning attractor. Untested. Implication: transformContext should generate semantic previews, not retrieval instructions.

## 2026-03-30 — Shed raw output at generation time, not at compaction time

Claude Code's microcompaction system persists tool results >50K chars to disk immediately, replacing inline content with a file path + 2KB preview. The threshold was lowered from 100K to 50K after observing quality gains. The design rationale is three-fold: (1) large inline results degrade reasoning quality on all context through attention dilution, not just by consuming space; (2) compaction summaries are lossy — a grep result summarized as "47 errors across 12 files" loses the specific detail needed two turns later; (3) compaction requires its own context headroom to run, so bloated context can prevent the cleanup pass entirely. The file-on-disk approach preserves full output for selective re-reading while keeping the active context clean for reasoning.
Implication: Observer verdicts should shed raw evidence to structured storage at write time, not carry it inline hoping compaction preserves the right details.

## 2026-03-30 — Uniform tool-output truncation causes agent spiraling, not laziness

The Operator's ~50-call spiral was not laziness. transformContext crushed fresh exec output (15,847 chars → 500-char preview at the 3000-char threshold), so the agent re-queried in smaller slices. Traces confirmed correct scripts — output destroyed before reasoning. Fix: age-aware threshold in agent.ts — fresh exec results (≤2 turns) get 10,000 chars; older results keep 3,000. Implication: When agent behavior looks lazy, check infra constraints before blaming the model.

## 2026-03-30 — LLMs don't naturally formulate good BM25 queries; environment constraints beat reasoning instructions for retrieval routing
LLMs produce natural language queries but BM25 requires lexical overlap — vocabulary mismatch is a known failure mode (Zilliz 2024, Elasticsearch 2026). Entire research subfields exist to compensate: query rewriting, query expansion, HyDE (Anyscale docs). Elasticsearch tested progressively explicit prompts for keyword extraction and found only the most prescriptive prompt improved retrieval, and marginally (+1pt). This confirms our own finding: prescriptive reasoning instructions are weak levers. For document retrieval routing, constraining what read returns (environment design) is more reliable than instructing the agent how to search. Implication: prefer mechanical constraints over skill-level retrieval guidance.

## 2026-03-30 — BM25 is sufficient for in-agent text-to-text matching without embeddings or vector infrastructure

rank_bm25 (Python, zero-dependency) returns ranked scores for every document in a corpus — giving relative confidence, multi-match overlap, and low-score detection as a positive finding ("no matching document exists"). Google's "Sufficient Context" (ICLR 2025) validates that detecting insufficient context is as valuable as retrieval itself. Runs inside a single exec call with no infrastructure beyond what the agent already has.
Implication: Fuzzy document matching (e.g., SOPs to ticket clusters) belongs in exec as a retrieval script, not in the model's head via read-everything-then-reason.

## 2026-03-30 — Smaller tool outputs improve LLM accuracy; longer context degrades reasoning even with perfect retrieval; production systems optimize for reasoning headroom, not utilization

Three independent findings. (1) Simplifying JSON tool responses by 12x improved LLM accuracy by 8–38 percentage points depending on the model — more raw data in context makes the model worse, not better (arXiv 2510.15955, October 2025). (2) Sheer input length degrades reasoning even when the model successfully locates the evidence, independent of the "lost in the middle" position effect — inserting 25k whitespace tokens into an otherwise correct prompt flips answers from right to wrong (arXiv 2510.05381, October 2025). (3) Anthropic's Claude Code saves large tool outputs to disk instead of inlining them, triggers compaction at ~75% utilization rather than 95% to preserve reasoning headroom, and ships Programmatic Tool Calling to move heavy data processing out of context entirely. Their finding: the optimization target is free context for reasoning, not maximum context utilization.

## 2026-03-30 — Tool return shape, not prompt instructions, determines whether agents use programmatic analysis — and skipping code actively degrades reasoning at any dataset size
 
When structured data fits in context, models rationally skip code and reason over raw records directly ("Coding Agents are Effective Long-Context Processors," arXiv 2603.20432). But this shortcut is actively harmful: input length alone degrades reasoning even when all evidence is retrievable and optimally positioned ("Context Length Alone Hurts LLM Performance Despite Perfect Retrieval," arXiv 2510.05381), superseding the older "Lost in the Middle" positional finding. The fix is environmental, not behavioral. Manus, Google ADK, and the CodeAct paper (ICML 2024, up to 20% higher success with code actions) all converge: tool API shape is a stronger behavioral attractor than skill instructions. A `read` tool that returns full file contents invites inline reasoning; one that returns a manifest (count, schema, sample rows, file path) forces `exec`. Design rule: `read` on a JSONL returns metadata by default, accepts an optional `record_id` for single-record retrieval. This encodes "aggregate to find patterns, read individuals to find causes" into the tool contract rather than relying on the prompt to override the model's preference for the lazy path.

## 2026-03-26 — Analytical guidance in skills shifts agent strategy from mechanism-finding to dimension-slicing, degrading performance with each iteration

Three runs on the same dataset: Run 1 (7 principles, ~800 words) found 3 mechanism-level findings by reading transcripts early. Run 2 (added rigor, ~1,000 words) found the same 3 plus investigated a dismissed cohort. Run 3 (added matched-input comparison, field-inventory, adjacent-evidence, ~1,200 words) missed the largest finding, promoted a correlation the reference rejected, and never read a transcript from the missed cohort. Each iteration made the agent more statistically sophisticated and less investigatively thorough. The added principles are correct methodology — but their volume created an attractor toward dimension-slicing that competed with the core instruction ("Numbers tell you where to look. The raw content tells you why"). Implication: when the core instruction already encodes the right strategy, elaboration dilutes it. Subtract before adding.

<img width="831" height="896" alt="Bildschirmfoto 2026-03-26 um 20 25 11" src="https://github.com/user-attachments/assets/e77dcfdd-7c77-439b-9596-5e6a3fd9a77a" />

## 2026-03-26 — Linearized triples outperform natural language prose for LLM knowledge matching

A 2025 Knowledge-Based Systems study found LLMs allocate attention more efficiently to raw (subject, predicate, object) triples than to the same facts converted into fluent sentences. Combined with DRAG (ACL 2025) showing graph-structured evidence needs 18.1% fewer tokens than raw text while hitting 94.1% on ARC-Challenge with an 8B model, the implication is clear: root causes stored as structured claims with typed relationships will let Haiku match work items more accurately and cheaply than prose descriptions or embedded paragraphs. Don't prettify knowledge for the model. [Full research summary](https://claude.ai/public/artifacts/020bfefd-bd0a-4b10-b6a1-e9a2c804a0d2)

## 2026-03-26 — Knowledge format is a stronger lever than model size for pattern matching accuracy

Google's Distilling Step-by-Step showed a 770M model beating a 540B model (700x smaller) when given structured rationales. MiniRAG hit comparable performance to full LLM-RAG at 25% storage. DRAG closed the gap further with no gradient training, purely through structured input. For Sincere's work-item-level agent, this means the expensive work should happen once at knowledge ingestion (Sonnet extracts and structures the root cause into typed triples with evidence chains), not repeatedly at matching time. Haiku watching live work items against pre-structured root causes is viable if the graph does the heavy lifting upstream. [Full research summary](https://claude.ai/public/artifacts/020bfefd-bd0a-4b10-b6a1-e9a2c804a0d2)

## 2026-03-25 | Skill descriptions that name the task type trigger reads; descriptions that include judgment criteria get skipped

Sonnet scored 5/5 on data-analysis (description: task type only, "understanding what happened and why from structured data") and 1/5 on transition-watch (description: task type + evaluation criteria, "assess whether transition is safe or should be held for review"). The model treats descriptions containing actionable criteria as sufficient context and skips reading the skill file. Descriptions that identify the task domain without revealing the methodology create an information gap that drives the model to load the file. Implication: skill descriptions should answer "what kind of work is this?" not "what should I do?"

## 2026-03-24 — Incremental persistence beats end-of-task summarization for long-horizon agents

Anthropic's context engineering guide (Sep 2025) identifies three techniques for long-horizon coherence: compaction (summarize + reinitiate), structured note-taking (persist conclusions outside the window), and sub-agent architectures (isolate deep work, return condensed summaries). The note-taking pattern is the most relevant to us: before a tool result ages out of context, the agent should have already written its conclusions somewhere persistent. The default failure mode is batching insight extraction to the end of an investigation, by which point early tool results have lost nuance or been compacted away. The fix is a write-through pattern — observe, conclude, persist — applied incrementally after each tool call, not as a final synthesis step.

## 2026-03-24 — pi-agent-core philosophy: Trust model reasoning over framework-injected ReAct scaffolding

pi-agent-core's loop is just: call LLM → execute tools → append results → call LLM again. No synthetic "Thought/Action/Observation" templates. Reasoning after tool results comes from the model natively (interleaved thinking, chain-of-thought). LangChain's ReAct pattern of templating reasoning steps made sense pre-frontier but now adds token overhead and constrains the model. Implication: Sincere's principle-driven Operator prompt is the right call — structural enforcement of reasoning steps is the mistake to avoid.

## 2026-03-24: "Reason before acting" principles apply constant cost for variable benefit; the failure they target may not be solvable at the prompt layer

When an agentic model skips tool-result evaluation, it is not missing an instruction to evaluate — next-token prediction flows past the pause point because the result looks routine. A prompt principle adds constant friction (latency, tokens) on every turn but only helps on the minority where momentum would have caused an error. The diagnostic question is not "what should the principle say" but "can prompt-level text solve this at all." Higher-leverage interventions operate at other layers: tool APIs returning structured completeness metadata, output schemas that mechanically separate interpretation from action selection, or model selection matched to the task's evaluation demands.

## 2026-03-24 — Agents without explicit reasoning between tool calls hit a hard performance ceiling (~28-45% success) regardless of model capability 

ReAct (ICLR 2023) showed +26pp on ALFWorld just from interleaving thought steps between actions; Reflexion (NeurIPS 2023) pushed that to 97% with inter-episode verbal self-critique. CRITIC (ICLR 2024) proved external tool feedback is required for reliable self-correction (internal-only critiques: -0.03 to +2.33 F1 vs. tool-grounded: +5.1-8.2 F1). The 2025-2026 frontier (ReTool, ARTIST, MAR) moves reflection from prompting to RL-trained capability, with multi-agent decomposition of critique consistently beating single-agent self-reflection due to confirmation bias. [Full research summary](https://claude.ai/public/artifacts/c4befae0-b7f7-48c1-9118-5d61b7740eae)

## 2026-03-24: LLM agents cannot self-correct semantic framing errors without external feedback from computation or reference data
 
Three research findings converge: anchoring bias in autoregressive generation (early outputs shape all downstream reasoning), the Einstellung effect (familiar surface features trigger rigid pattern matching over flexible reasoning, Nature 2025), and the inability of LLMs to self-correct reasoning without external feedback (Huang et al. 2024). Skills should create conditions for data to contradict the agent's framing, not instruct it to "think harder."

## 2026-03-24: Silent semantic assumptions encoded as code are the highest-leverage single point of failure in agentic data analysis
 
Our agent wrote `is_resolved(t): return t['status'] in ('resolved', 'closed')` with zero reasoning commentary, hiding 36/72 tickets and missing the two largest findings. Cowork avoided this because a surprising computation result (diagnostic messages = 0.00 across all outcomes) triggered record-level reads that revised the framing. The fix in the skill is a transition signal, not a procedural gate.

## 2026-03-24 — Skills are pattern-matching attractors that cause goal drift proportional to their procedural specificity and length

Arike et al. (2025) showed goal drift correlates with pattern-matching susceptibility as context grows. Inherited Goal Drift (2026) found that prefilled reasoning patterns propagate forward and that missing scope constraints cause ambiguity-driven drift. Applied to skills: procedural instructions ("write a script, narrate output") create stronger attractors than goal statements ("aggregate to find patterns, then read records to find causes"). Drift-resistant skills encode goals, transition signals (when to shift modes), and exit conditions (when to stop applying) rather than step-by-step procedures.

## 2026-03-23 — A skill that optimizes computation method without encoding evidence depth will produce accurate statistics and shallow findings

The investigation-analysis skill correctly eliminated fabrication by moving from fragmented greps to a single Python script over the full dataset. But by framing the task as "quantitative analysis" and instructing the agent to narrate from script output alone, it set the ceiling at correlation. All four reference root causes required reading unstructured content inside records (transcripts, event logs) and cross-referencing against SOP documents — neither of which the skill mentioned or permitted. The agent obeyed the skill perfectly: it wrote clean cross-tabs, avoided sequential tool calls, and narrated from computed output. It scored well on its own rubric while missing every causal mechanism. A skill must encode what constitutes a complete answer for the task domain, not just how to use the tools safely.

## 2026-03-23 — Prescriptive reasoning instructions don't change LLM output when the task context is sufficient

Ran 3 variants of a prompt across 200 tickets via Claude Cowork: explicit hypothesis instruction, indirect scientific method framing, and no mention at all. All 3 produced the same 4 findings. The model infers the reasoning strategy from the shape of the input data, not from meta-instructions about how to think. Implication: optimize the data and task framing, not the reasoning process description. This aligns with the lean prompt philosophy in CLAUDE.md — trust the agent, don't over-prescribe.
