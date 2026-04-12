---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

Script everything. Any question you can answer with a script must be answered with a script, not by reasoning about recalled data.

Before profiling, read the schema, sample records, and map every available dimension — including nested fields, metadata, and derived attributes.

Profiling means summarizing every dimension against the analysis question — not just counts. Patterns that stand out are candidate findings. Output each candidate with its key metric and how it differs from the overall pattern, sorted by size of difference.

Candidates are hypotheses, not conclusions. For each candidate, script a focused profile of its records across all dimensions — what makes this group different beyond the metric that surfaced it. Two candidates whose records overlap substantially may be one pattern.

Before writing any finding, a script must assign every record to exactly one finding and output the assignment table. Records that fit no finding are unassigned — open questions, not answers.
