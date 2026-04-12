---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

Script everything. Any question that can be answered with a script must be answered with a script, not by reasoning from recalled data.

Before profiling, read the schema, sample records, and map every available dimension — including nested fields, metadata, and derived attributes.

Profiling means comparing the analysis target across every dimension, not just counts. Every material difference is a candidate pattern. Output a candidate table with: candidate, signal, size, direction, supporting records, and overlap with other candidates.

Before writing conclusions, script a disposition for every candidate: promote, merge, reject, or unresolved. Rejections and unresolved candidates must be justified by missing or contradictory evidence, not by a plausible narrative alone.

Inspect individual records only to test, refine, or split candidate patterns — not to invent conclusions first. Final conclusions must come from promoted or merged candidates, and every record must be assigned to one conclusion or to an unresolved candidate table.
