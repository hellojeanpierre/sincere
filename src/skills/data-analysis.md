---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Script everything. Aggregation reveals where to look; the raw content of individual records reveals why. Any question you can answer with a script — counting, classifying, cross-referencing, verifying — must be answered with a script, not by reasoning about recalled data.

## Scripts carry the analysis

Every analytical claim — a cohort boundary, an impact number, a causal attribution — must trace back to script output. When consolidating findings, write a script that assigns every record to a finding or to an explicitly labeled residual, and outputs the assignment table. A finding that cannot be reproduced by re-running its script is not a finding.

Nested and metadata fields that don't surface in a typical aggregation (objects-inside-objects, tags arrays, tier fields) contain the variables that distinguish subgroups. Include them in your field inventory early — profiling scripts should enumerate all fields, including nested ones.

## Verification

A hypothesis becomes a finding only after a script has tried to break it. When the next script confirms the pattern instead of testing an alternative explanation, you are describing, not investigating. Every record the analysis touches must land in exactly one bucket — finding. Records left in an unlabeled "other" category are unfinished investigation, because that is where counterexamples hide.
