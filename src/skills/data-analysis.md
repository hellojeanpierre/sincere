---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
---

# Data Analysis

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. The raw content tells you why. A pattern becomes a finding only after attempts to disprove it with the available data have failed.

## Before scripting

Verify total record count and field inventory programmatically. Previews may truncate, and a partial view will silently scope every downstream hypothesis to whatever the preview contained.

## Investigation framework

Write Python scripts that load the full dataset and compute aggregates. Process cohorts as batches, not one record at a time.

**Completeness.** Every record with a non-success outcome needs a specific, named explanation. A "baseline failure rate" is not an explanation — it is the set of records you haven't explained yet. If your model of the data doesn't account for all observations, the investigation is not finished. Assigning a batch of records to a single label ("appropriate," "expected," "normal") is not explaining them — if the label was not produced by a query that tested each record against explicit criteria, it is a proxy for "I haven't looked yet."

**Falsification.** When a hypothesis forms — including dismissals like "expected," "appropriate," or "not interesting" — the next query tries to break it, not describe the pattern further. A dismissed cohort that was never queried at the individual-record level is a hypothesis you accepted without evidence. A difference that dissolves at finer granularity was a composition artifact, not a cause. When a result contradicts your expectation (a "bad" cohort outperforms a "good" one, a fix correlates with worse outcomes), stop and investigate the mechanism that produces it. The surprising result is usually the most important finding in the dataset.

**Decomposition.** When you assign records to a cohort, test whether the cohort is internally uniform before reporting it as a finding. Compute the outcome rate for each subgroup within the cohort. If the rates diverge, the cohort contains distinct causes and must be split. A finding that mixes avoidable failures with structural ones produces an impact number that is technically correct and practically useless. When a split produces subgroups with fewer than ~30 records, flag the finding as tentative rather than reporting divergent rates as conclusive. Conversely, when a cohort is uniform on the outcome, it is not yet explained — it is merely identified. The mechanism that produces the pattern is what makes a finding actionable.

**Independence.** When a variable correlates with the outcome, test whether the correlation survives after removing the records already explained by your primary findings. If the gap collapses, say so explicitly — it protects the reader from pursuing interventions that would not move the metric.

**Adjacent evidence.** After identifying a cohort, the most informative next query comes from a different axis than the one that produced the identification. When records contain sequential data, read the entries closest to the terminal state — the root cause usually lives in the last substantive events, not the opening. When the dataset contains quality, audit, scoring, or classification fields, intersect them with each primary cohort before concluding. A quality process that samples a failure cohort at high rates but doesn't change outcomes is a different finding than one that misses the cohort entirely — both look identical in the aggregate; only the intersection reveals which one you have.

**Label validity.** When fields are outputs of a process that observes, labels, or scores the primary records, treat them as claims with their own error rate, not as ground truth. Validate them against the primary data before using them to filter, label, or explain records.

**Rejected hypotheses.** Include hypotheses that were tested and eliminated alongside the ones that survived — what was checked, what the result was, and why it was ruled out. This prevents the reader from re-investigating dead ends.

## Failure modes

- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.
- Treating nested or semi-structured fields as flat — keyword searches and pattern-matching produce proxies for the answer, not the answer itself.
- Spending disproportionate effort on the first cohort discovered and progressively less on each subsequent one.
take a
