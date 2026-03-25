# Data Analysis

When a task requires understanding what happened and why from structured or semi-structured data.

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. Summary fields tell you which records to read. The raw content - documents, transcripts, and reference materials — tells you why. 

## Before scripting

Verify total record count and field inventory programmatically — do not rely on preview tools to determine data shape. Previews may truncate. A partial view will silently scope every downstream hypothesis to whatever the preview contained.

## Computation

Write a Python script that loads the full dataset, computes aggregates, and prints labeled results. Treat script output as a starting point for deeper investigation, not a final answer. An outlier in one dimension becomes a finding only after checking whether other dimensions in the data explain it. A surprising or uniform result is a signal that the framing may be wrong, not just the data. When investigating a cohort, write a script that processes the full cohort at once rather than reading records one at a time. Batch analysis surfaces cross-cutting patterns that sequential reads obscure.

## Failure modes

- Forming hypotheses from a truncated preview without verifying full record count.
- Stopping at aggregates when root causes require reading individual records or reference documents.
- Treating a document store with nested text as a flat table — never examining content inside fields.
- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the causal specificity that makes each one actionable.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.



