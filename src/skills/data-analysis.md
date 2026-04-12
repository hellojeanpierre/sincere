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

When fields are themselves outputs of a labeling, scoring, or classification process, treat them as claims with their own error rate — validate them against the primary data before using them to partition, group, or explain records.

Before profiling, understand the shape of the data. Read the schema, sample records, and map every available dimension — including nested fields, metadata, and derived attributes. Profiling is only as complete as your understanding of what dimensions exist.

Profiling means computing the outcome metric across every available dimension. Counts alone are not profiling — a dimension is profiled when its subgroups' outcome rates are compared to the aggregate. Subgroups that diverge from the aggregate are candidate findings. The profiling script should output each candidate with its outcome rate and gap from baseline, sorted by gap size.

Profiling surfaces two kinds of signals: properties of individual records (what happened in this case) and structural patterns across groups (which subgroups consistently over- or under-perform the aggregate). Structural patterns are stronger starting points for findings because they point to systemic causes rather than individual failures.

Grouping records into findings is classification. Start from the structural patterns that profiling surfaced, not from individual records. Individual records explain why a structural pattern exists — the pattern itself comes from the aggregate. The filter logic that assigns each record defines the cohort boundary — without it, the finding's scope is whatever you recall, not what the data shows. Before writing any finding, a script must test every record to exactly one finding and output the assignment table. Records that fit no finding are unassigned — they are open questions, not answers.

## Failure modes

- Classifying by reasoning about individual records instead of by structural patterns from profiling — individual cases explain the why, aggregate divergences define the what.
- Computing counts per dimension without outcome rates. That is counting, not profiling.
- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into the background instead of treating them as unfinished investigation.
