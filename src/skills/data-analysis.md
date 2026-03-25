# Data Analysis

When a task requires understanding what happened and why from structured or semi-structured data.

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. Summary fields tell you which records to read. The raw content — documents, transcripts, and reference materials — tells you why. A pattern becomes a finding only after attempts to disprove it with the available data have failed.

## Before scripting

Verify total record count and field inventory programmatically — do not rely on preview tools to determine data shape. Previews may truncate. A partial view will silently scope every downstream hypothesis to whatever the preview contained.

## Computation

Write a Python script that loads the full dataset, computes aggregates, and prints labeled results. When investigating a cohort, write a script that processes the full cohort at once rather than reading records one at a time.

When a hypothesis forms during investigation, the next query should test that specific hypothesis — not describe the pattern further. Compare failure cohorts structurally against corresponding success cases at the finest grain the data supports — not just the broad category. A difference between actors that dissolves at finer granularity was a composition artifact, not a cause.

When a result contradicts the expected direction, the next tool call investigates the mechanism. If a signal expected to hurt outcomes actually helps, ask what intervention that signal triggers. Dropping a surprising result discards exactly the evidence that would challenge a shallow framing.

Once you assign records to cohorts or patterns, those labels become first-class dimensions. Slice every other system visible in the data — oversight, scoring, workflow — by the pattern labels you created. Investigate whether each has distinct failure modes rather than treating it as a single pass/fail.

A clean partition is a starting point, not an endpoint. After defining a cohort, test whether every member shares the same root cause by checking whether peers handling the same conditions (same intent, same complexity tier) produce different outcomes. If peers succeed where the cohort fails, the failure is avoidable and the actors are the cause. If peers also fail, the failure is structural and the conditions are the cause. A cohort that mixes both contains excess failures and a baseline — split them and attribute impact separately.

For each record examined, state what the actors' observable states were, what action was taken, and why that action produced the outcome — a causal sentence, not a transcript summary.

When a variable correlates with the outcome, test whether the correlation survives controlling for the patterns you already identified. If removing your primary-finding records collapses the gap, state that explicitly as a dismissed hypothesis. The absence of independent explanatory power protects the reader from pursuing interventions that would not move the metric.

## Failure modes

- Treating a document store with nested text as a flat table — never examining content inside fields.
- Truncating record content in your own scripts then reasoning from the truncated version.
- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the causal specificity that makes each one actionable.
- Treating a cohort as internally uniform without testing whether peers handle the same conditions successfully — conflating avoidable and structural failures under one impact number.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.
- Computing a cross-tabulation without stating what it means for the hypothesis under test.
