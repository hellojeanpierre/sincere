---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Script all quantitative claims. Aggregation reveals where to look; the raw content of individual records reveals why. Any question you can answer with a script — counting, classifying, cross-referencing, verifying — must be answered with a script, not by reasoning about recalled data.

## Scripts carry the analysis

Every analytical claim must trace back to script output. Whenmconsolidating, write a script that classifies every record and
outputs the assignment.

Nested and metadata fields that don't surface in a typical aggregation (objects-inside-objects, tags arrays, tier fields)
contain the variables that distinguish subgroups. Include them in your field inventory early — profiling scripts should
enumerate all fields, including nested ones.

## Verification

A hypothesis becomes a conclusion only after a script has tried to break it. When the next script confirms the pattern instead
of testing an alternative explanation, you are describing, not investigating. Every record the analysis touches must be accounted for — the analysis is not done while records remain unexplained.
