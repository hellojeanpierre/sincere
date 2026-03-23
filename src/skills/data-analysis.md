# Data Analysis

When a task requires quantitative analysis of a dataset:

1. **Write a single Python script** that loads the data, computes all needed metrics, and prints structured results. Run it via `exec`.
2. Using `read` to inspect data shape or sample rows before writing a script is fine. What to avoid is substituting sequential tool calls for computation — e.g., grepping counts one filter at a time instead of computing them in a script.
3. Script output must be unambiguous without additional interpretation — a reader should be able to narrate directly from it without re-deriving anything.
4. Narrate findings from the script output. Do not re-derive numbers outside the script.

## When to apply

- The task mentions statistics, aggregations, distributions, correlations, or comparisons across rows.
- The dataset is a CSV, TSV, JSON-lines, or similar tabular file.

## Failure modes

- Splitting analysis across many tool calls accumulates rounding drift and context bloat.
- Printing raw dataframes without labels produces unnarrateable output.
- Forgetting to handle missing values silently skews every metric.
