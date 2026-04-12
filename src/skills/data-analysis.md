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

Before profiling, understand the shape of the data. Read the schema, sample records, and map every available dimension — including nested fields, metadata, and derived attributes. Profiling is only as complete as your understanding of what dimensions exist.

Profiling means computing the outcome metric across every available dimension. Counts alone are not profiling — a dimension is profiled when its subgroups' outcome rates are compared to the aggregate. Subgroups that diverge from the aggregate are where findings begin.

When fields are themselves outputs of a labeling, scoring, or classification process, treat them as claims with their own error rate — validate them against the primary data before using them to partition, group, or explain records.


## Failure modes

- Computing counts per dimension without outcome rates. That is counting, not profiling.
- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into the background instead of treating them as unfinished investigation.
