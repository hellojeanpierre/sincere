# Learnings

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
