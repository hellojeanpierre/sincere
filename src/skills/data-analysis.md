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

Profiling means scripting breakdowns across every available dimension, including nested and metadata fields. Subgroups that stand out from the aggregate are where findings begin. When fields are themselves outputs of a labeling, scoring, or classification process, treat them as claims with their own error rate — validate them against the primary data before using them to partition, group, or explain records. When profiling surfaces strong signals on multiple dimensions, each is a candidate grouping. Script each before selecting — the findings are the groupings that hold up, not the groupings that seemed most explanatory when you read the profiling output.

Grouping records into findings is classification. The filter logic that assigns each record defines the cohort boundary — without it, the finding's scope is whatever you recall, not what the data shows. Before writing any finding, a script must assign every record to exactly one finding and output the assignment table. Records that fit no finding are unassigned — they are open questions, not answers. When a script returns record-level detail, the next action is another script that classifies those records — not reasoning about them in context.


## Failure modes

- Encoding an analytical assumption as a code filter that silently excludes the records that would challenge it.
- Collapsing distinct patterns into a single finding, losing the specificity that makes each actionable.
- Absorbing unexplained records into the background instead of treating them as unfinished investigation.
