---
name: case-quality-gate
description: Assess whether a case transition (closure, escalation, reroute, handoff) is safe or should be held for review. Use at any decision point where a support case changes state. Trigger on QA checks, case audits, and transition validation tasks.
---

# Case Quality Gate

## Core principle

A transition is safe when the action taken matches what the customer's situation actually required. It is risky when there is a nameable gap between what was needed and what was delivered. Default to letting the transition proceed — most transitions are clean. Hold only when you can point to the specific gap. Vague unease is not a hold signal.

## What arrives

The case arrives as structured data: a conversation between customer and agent, metadata (timestamps, category, priority, routing), and the proposed transition. The conversation is the primary evidence. Metadata is supporting context — it cannot prove a resolution is correct, but it can reveal when something is wrong (e.g., the assigned category contradicts what the customer actually said).

## Hold signals

These are the patterns that indicate a gap worth holding for. Weight recent messages more heavily — they reflect the current state of the issue and are where unresolved problems surface.

**The resolution doesn't match the complaint.** Not whether the agent did *something*, but whether they did the *right thing* for this specific situation. A generic template applied to a nuanced problem is a gap. A correct but partial fix that ignores a secondary issue the customer raised is a gap.

**The metadata contradicts the conversation.** When the customer's own words — subject, description, specific phrases — describe a different issue than the assigned category or routing, the case was mislabeled. A response built on the wrong classification cannot resolve the right problem, even if the response sounds reasonable on its own.

**The process was flawed, even if the outcome looks right.**
- The agent followed a procedure that doesn't apply to this case.
- The agent skipped a required handoff that the case warranted.
- The agent lacks the domain context to have resolved this correctly, and no specialist was consulted.
- Conflicting policies were in play and the agent picked one without acknowledging the tension.

**Resolution speed is suspicious for the complexity.** A fast close on a simple, known-answer question is fine. A fast close on a case requiring investigation or verification warrants scrutiny.

## What clean looks like

A clean transition has: the customer's stated issue addressed directly, no unanswered questions or new details left hanging, metadata consistent with the conversation, and a resolution path appropriate for the issue type. When these hold, let it pass.

## Failure modes to avoid in your own assessment

- Treating agent activity as resolution — a response was sent, but the issue wasn't addressed.
- Flagging clean transitions because the topic sounds complex — complexity alone is not risk.
- Missing metric gaming: rushed closures, avoided escalations, unnecessary reroutes that serve the agent's stats rather than the customer.
- Accepting a resolution that followed correct procedure when the procedure itself was wrong for this case.
