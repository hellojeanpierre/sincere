# Data Analysis

When a task requires understanding what happened and why from structured or semi-structured data.

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. Summary fields tell you which records to read. The raw content — documents, transcripts, and reference materials — tells you why. A pattern becomes a finding only after attempts to disprove it with the available data have failed.

## Before scripting

Verify total record count and field inventory programmatically — do not rely on preview tools to determine data shape. Previews may truncate. A partial view will silently scope every downstream hypothesis to whatever the preview contained.

## Computation

Write a Python script that loads the full dataset, computes aggregates, and prints labeled results. When investigating a cohort, write a script that processes the full cohort at once rather than reading records one at a time. Batch analysis surfaces cross-cutting patterns that sequential reads obscure.

Treat script output as a starting point for deeper investigation, not a final answer. When a hypothesis forms during investigation, the next query should test that specific hypothesis — not describe the pattern further. Compare failure cohorts structurally against corresponding success cases at the finest grain the data supports — not just the broad category. A difference between actors that dissolves when you zoom into intent or issue type within that category was a composition artifact, not a cause.

When a result contradicts the expected direction, the next tool call investigates the mechanism. If a signal expected to hurt outcomes actually helps, ask what intervention that signal triggers. Dropping a surprising result discards exactly the evidence that would challenge a shallow framing.

Once you assign records to cohorts or patterns, those labels become first-class dimensions. Slice every secondary system — quality sampling, scoring, routing — by the pattern labels you created. These cross-cuts reveal whether secondary systems are catching the problems you found or missing them. If a secondary system appears in the data, investigate whether it has distinct failure modes — a system that under-samples one cohort and over-samples-but-fails-to-correct another has two separate problems requiring two separate fixes.

Reading individual records means characterizing the mechanism, not printing the content. For each record examined, state what the actors' observable states were, what action was taken, and why that action produced the outcome. "Customer was actively engaged and had not received an actionable next step when the agent applied closure" — not "customer said X, agent said Y."

When a variable correlates with the outcome, test whether the correlation survives controlling for the patterns you already identified. If removing your primary-finding records collapses the gap, state that explicitly as a dismissed hypothesis. The absence of independent explanatory power protects the reader from pursuing interventions that would not move the metric.

## Failure modes

- Forming hypotheses from a truncated preview without verifying full record count.
- Stopping at aggregates when root causes require reading individual records or reference documents.
- Treating a document store with nested text as a flat table — never examining content inside fields.
- Truncating record content in your own scripts then reasoning from the truncated version.
- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the causal specificity that makes each one actionable.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.
- Noting a surprising or counterintuitive result in reasoning and then not issuing a follow-up query to investigate it.
- Computing a cross-tabulation without stating what it means for the hypothesis under test.
- Creating analytical labels (cohorts, patterns) and never using them as filter dimensions in subsequent analysis.
