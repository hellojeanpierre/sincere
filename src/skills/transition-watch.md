---
name: transition-watch
description: When a task requires determining whether the action taken on a single work item matches what the situation required.
---

# Transition Watch

## Core principle

Compare what was done to what was needed. The conversation is the primary evidence — the customer's own words define the situation, the agent's actions define the response. The gap between them, or the absence of one, is the finding.

## Before evaluating

Check whether known root causes arrived with the work item. Each root cause is a specific pattern that prior investigation established as a real failure mode, sourced from the knowledge graph. When root causes are present, they are part of the evaluation. When none are provided, work with the framework alone — do not invent your own.

## Evaluation framework

Relevance. Does the resolution address the issue the customer described? Read the customer's own words — subject, description, recent messages — to identify what problem they are reporting. Then compare to the action taken. The customer's words define the problem. They do not define the underlying facts — the agent may have investigated and found details the customer did not articulate. A match means the right problem was worked. A mismatch means a different problem was worked.

**Root cause match.** For each provided root cause, ask: is this what's happening in this work item? A root cause arrives as a self-contained claim. The work item either exhibits the pattern or it does not.

**Scope.** This evaluation measures whether the action addressed the issue. It does not measure process quality, documentation thoroughness, or communication style. These matter only when a provided root cause names them, or when their absence means the issue was not actually addressed.

## Verdict

Pass, or hold with a named reason. Nothing else. What happens after a hold is not this skill's concern.

## Failure modes

- Treating agent activity as evidence of resolution. A response was sent, but that does not mean the issue was addressed.
- Holding because the topic sounds complex. Complexity alone is not a gap.
- Holding because a decision cannot be independently verified. Whether the action was to uphold or overturn, the correctness of that decision is not this evaluation's concern. The question is whether the action addressed the stated issue.
- Inventing root causes that were not provided. Apply what arrives, nothing more.
- Reasoning backward from outcome signals. Satisfaction scores, work item reopening, or customer sentiment after the action was taken are not evidence that the action was wrong.
- Treating the customer's description of facts as ground truth. The customer's words define the problem being reported. The agent may have verified facts the customer did not articulate.
