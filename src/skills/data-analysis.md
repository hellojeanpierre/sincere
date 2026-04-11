---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Script everything. Any question you can answer with a script — counting, classifying, cross-referencing, verifying — must be answered with a script, not by reasoning about recalled data.

## Scripts carry the analysis

Every analytical claim must trace back to script output.

Profiling means breaking the data across every available dimension, including nested and metadata fields. Subgroups that stand out from the aggregate are where findings begin. When fields are themselves outputs of a labeling, scoring, or classification process, treat them as claims with their own error rate — validate them against the primary data before using them to partition, group, or explain records.

Grouping records into findings is classification — a scripting task, not a reasoning task. Before writing any finding, a script must assign every record to exactly one finding and output the assignment table. Records that fit no finding are unassigned — they are open questions, not answers.

## Verification

A hypothesis becomes a finding only after a script has grouped the same records on a different dimension and the hypothesis still held. When the next script confirms your grouping instead of testing an alternative, you are describing, not investigating.

When you assign records to a cohort, test whether the cohort is internally uniform. If subgroups within it diverge, the cohort contains distinct patterns and must be split. A finding that mixes them produces a result that is technically correct and practically useless.

When a variable appears to explain records, test whether the explanation survives after removing records already covered by prior findings. If the gap collapses, the variable is confounded, not causal.

## Failure modes

- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into the background instead of treating them as unfinished investigation.
