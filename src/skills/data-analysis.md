# Data Analysis

When a task requires understanding what happened and why from structured or semi-structured data.

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. The raw content tells you why. A pattern becomes a finding only after attempts to disprove it with the available data have failed.

## Before scripting

Verify total record count and field inventory programmatically. Previews may truncate, and a partial view will silently scope every downstream hypothesis to whatever the preview contained.

## Investigation framework

Write Python scripts that load the full dataset and compute aggregates. Process cohorts as batches, not one record at a time.

**Completeness.** Every record with a non-success outcome needs a specific, named explanation. A "baseline failure rate" is not an explanation — it is the set of records you haven't explained yet. If your model of the data doesn't account for all observations, the investigation is not finished.

**Falsification.** When a hypothesis forms, the next query tries to break it — not describe the pattern further. Compare failure cohorts against success cases at the finest grain the data supports. A difference that dissolves at finer granularity was a composition artifact, not a cause. A surprising result is the highest-value evidence — investigate its mechanism rather than dropping it.

**Decomposition.** When you assign records to a cohort, test whether the cohort is internally uniform. If different subgroups within it have different causes — some avoidable, some structural — split them. A finding that mixes distinct causes produces an impact number that is technically correct and practically useless.

**Independence.** When a variable correlates with the outcome, test whether the correlation survives after removing the records already explained by your primary findings. If the gap collapses, say so explicitly — it protects the reader from pursuing interventions that would not move the metric.

## Failure modes

- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.
- Treating nested or semi-structured fields as flat — never reading the content inside.
