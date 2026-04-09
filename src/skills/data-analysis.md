---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Aggregate to find patterns, then read the full content of individual records to find causes. Numbers tell you where to look. The raw content tells you why.

## Before scripting

Fields you never inspect cannot produce findings. Verify the field inventory of the dataset — including nested and metadata fields that won't surface in a typical aggregation query.

## Investigation framework

Write Python scripts that compute aggregates.

**Completeness.** Every record in the dataset that the investigation covers needs a specific, named explanation — not a category. When a record's own fields describe a resolution, that description is a claim, not proof — verify it against the authoritative source before accepting it. A label assigned to leftover records is a name for the gap, not a finding.

**Falsification.** When a hypothesis forms, the next query tries to break it — not describe the pattern further. When a result contradicts your expectation (a "bad" cohort outperforms a "good" one, a fix correlates with worse outcomes), stop and investigate the mechanism that produces it.

**Decomposition.** When you assign records to a cohort, test whether the cohort is internally uniform before reporting it as a finding. Compute the outcome rate for each subgroup within the cohort. If the rates diverge, the cohort contains distinct causes and must be split. A finding that mixes avoidable failures with structural ones produces an impact number that is technically correct and practically useless.

**Independence.** When a variable correlates with the outcome, test whether the correlation survives after removing the records already explained by your primary findings. If the gap collapses, say so explicitly — it protects the reader from pursuing interventions that would not move the metric.

## Failure modes

- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into a "healthy baseline" instead of treating them as unfinished investigation.
- Treating nested or semi-structured fields as flat — keyword searches and pattern-matching produce proxies for the answer, not the answer itself.
- Grounding a finding in recalled data instead of current query output — if a value matters enough to cite, it matters enough to verify.

