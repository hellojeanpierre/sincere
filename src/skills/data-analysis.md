---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

Script everything. Any question you can answer with a script must be answered with a script, not by reasoning about recalled data.

Before profiling, read the schema, sample records, and map every available dimension — including nested fields, metadata, and derived attributes.

Profiling means summarizing every dimension against the analysis question — not just counts. Patterns that stand out are candidate findings. Output each candidate with its key metric and how it differs from the overall pattern, and how much its records overlap with other candidates — sorted by size of difference

Before writing any finding, a script must assign every record to exactly one finding and output the assignment table. Records that fit no finding are unassigned — open questions, not answers.
