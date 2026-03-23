# Learnings

## 2026-03-23 — Prescriptive reasoning instructions don't change LLM output when the task context is sufficient

Ran 3 variants of a prompt across 200 tickets via Claude Cowork: explicit hypothesis instruction, indirect scientific method framing, and no mention at all. All 3 produced the same 4 findings. The model infers the reasoning strategy from the shape of the input data, not from meta-instructions about how to think. Implication: optimize the data and task framing, not the reasoning process description. This aligns with the lean prompt philosophy in CLAUDE.md — trust the agent, don't over-prescribe.

## 2025-03-23 — A skill that optimizes computation method without encoding evidence depth will produce accurate statistics and shallow findings

The investigation-analysis skill correctly eliminated fabrication by moving from fragmented greps to a single Python script over the full dataset. But by framing the task as "quantitative analysis" and instructing the agent to narrate from script output alone, it set the ceiling at correlation. All four reference root causes required reading unstructured content inside records (transcripts, event logs) and cross-referencing against SOP documents — neither of which the skill mentioned or permitted. The agent obeyed the skill perfectly: it wrote clean cross-tabs, avoided sequential tool calls, and narrated from computed output. It scored well on its own rubric while missing every causal mechanism. A skill must encode what constitutes a complete answer for the task domain, not just how to use the tools safely.
