---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Script everything. Aggregation reveals where to look; the raw content of individual records reveals why. Any question you can answer with a script — counting, classifying, cross-referencing, verifying — must be answered with a script, not by reasoning about recalled data.

## Scripts carry the analysis

Every analytical claim — a cohort boundary, an impact number, a causal attribution — must trace back to script output.

Profiling scripts should enumerate all fields, including nested ones (objects-inside-objects, tags arrays, tier fields). These contain the variables that distinguish subgroups.

Grouping records into findings is classification — a scripting task, not a reasoning task. Before writing any finding, a script must assign every record to exactly one finding and output the assignment table. If a record fits no finding, the script outputs it as unassigned and the analysis continues.

## Verification

A hypothesis becomes a finding only after a script has grouped the same records on a different dimension and the hypothesis still held. When the next script confirms your grouping instead of testing an alternative, you are describing, not investigating.
