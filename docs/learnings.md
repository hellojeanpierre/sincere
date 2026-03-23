# Learnings

## 2026-03-23 — Prescriptive reasoning instructions don't change LLM output when the task context is sufficient

Ran 3 variants of a prompt across 200 tickets via Claude Cowork: explicit hypothesis instruction, indirect scientific method framing, and no mention at all. All 3 produced the same 4 findings. The model infers the reasoning strategy from the shape of the input data, not from meta-instructions about how to think. Implication: optimize the data and task framing, not the reasoning process description. This aligns with the lean prompt philosophy in CLAUDE.md — trust the agent, don't over-prescribe.
