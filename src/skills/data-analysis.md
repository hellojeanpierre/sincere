---
name: data-analysis
description: When a task requires analyzing, diagnosing, or investigating structured or semi-structured data to answer questions about what's in it or why something happened.
roles: [operator]
---

# Data Analysis

## Core principle

Script everything. Any question you can answer with a script — counting, classifying, cross-referencing — must be answered with a script, not by reasoning about recalled data. Prefer fewer, wider scripts that cross-tabulate multiple fields over many narrow scripts that each probe one dimension.

## Depth comes from fields, not passes

The variables that distinguish subgroups hide in nested and metadata fields (objects-inside-objects, tags arrays, tier fields). Include all fields — including nested ones — in your analysis scripts from the start, so a single pass surfaces the distinctions that would otherwise require follow-up queries.
