---
name: sop-adherence
description: When a root cause match involves procedural deviation and the observer needs to distinguish whether the deviation was contextually appropriate or harmful.
---

# SOP Adherence

## Core principle

Deviation from procedure is significant only when it correlates with harm. The same deviation can be a judgment call or a failure depending on the work item context. The skill helps qualify a root cause match, not find one.

## Before evaluating

Confirm which SOP applies to this work item. SOPs are too large to read into context. If multiple SOPs are plausible for the issue type, the agent's choice between them may be the real decision point — not whether they followed the chosen one precisely. If the wrong SOP was applied entirely, the root cause is misidentification, not deviation.

## Evaluation framework

**Deviation and outcome.** A deviation that produces a better outcome for the customer is not a flag — it is evidence that the root cause does not apply to this work item type. A deviation that produces a worse outcome is the core signal. When both patterns exist, collapsing them into a single finding destroys the specificity that makes each actionable.

**Contextual qualification.** A root cause validated in aggregate does not apply universally. When the observer matches a pattern like "skipping step X leads to poor outcomes," test whether this specific work item is one where the correlation holds. The work item context — issue complexity, prior interactions, what information was available to the agent — may make the deviation the correct response.

**Deviation must be independently observable.** Inferring deviation from outcome alone is circular. The deviation needs its own signal in the work item data: a mismatch between what was done and what the SOP prescribes, handle time inconsistent with required steps, or documented actions that skip a prescribed sequence. Outcome indicators confirm harm, not deviation.

## Failure modes

- Flagging deviation regardless of outcome, treating conformity as the goal rather than resolution.
- Treating a root cause validated in aggregate as universally applicable without testing it against the specific work item context.
- Classifying process design failures as agent failures — if compliant agents produce bad outcomes, the SOP is the root cause, not the agent.
- Inferring deviation from outcome alone without an independent procedural signal.
