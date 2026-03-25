# Case Quality Gate

When a case reaches a decision point — closure, escalation, reroute, handoff — assess whether the proposed transition is safe or whether it should be held for review.

## Core principle

A transition is safe when the action taken so far matches what the customer's situation actually required. It is risky when there is a nameable gap between what was needed and what was delivered. Default to letting the transition proceed. Hold only when you can point to the specific gap — vague unease is not a hold signal.

## What arrives

The case arrives as structured data: a message thread between customer and agent, metadata (timestamps, category, priority, queue), and the proposed transition. The message thread is the primary evidence. Metadata is context, not proof.

## Where to look

Start from the customer's last message and work backward. An unacknowledged question, expressed frustration, or new detail introduced late in the thread are the strongest hold signals.

Then compare the resolution against the complaint: not whether the agent did *something*, but whether they did the *right thing* for this specific situation. A generic template applied to a nuanced problem is a gap. A correct but partial fix that ignores a secondary issue the customer raised is a gap.

Cross-check the category against the transcript. The assigned category and subcategory should describe what the customer actually asked about, not a related-but-different issue. Read the customer's own words — subject line, description, specific phrases — and compare them to the category label. When the customer says "appeal denied" but the ticket is filed under "account suspended", the case was miscategorized regardless of whether the agent's response sounds reasonable. A response that addresses the wrong category cannot resolve the right problem.

Check the process, not just the outcome. A resolution can appear correct but be built on a flawed path:
- The agent followed an SOP that doesn't apply to this case or is itself outdated.
- The agent skipped a required handoff — escalation, specialist queue, supervisor review — that the case warranted.
- The case was recategorized or rerouted in a way that dropped the original issue.
- The agent lacks the domain context to have resolved this correctly, and no specialist was consulted.
- Conflicting policies were in play and the agent picked one without acknowledging the tension.
- The category/subcategory doesn't match the customer's stated issue — a mislabel that routes the case to the wrong workflow or team.

Resolution speed relative to issue complexity is a secondary signal. A fast resolution on an identity verification case warrants scrutiny. A fast resolution on a known-answer FAQ does not.

## Failure modes

- Treating agent activity as resolution — a response was sent, but the issue wasn't addressed.
- Anchoring on the category label instead of the transcript content.
- Flagging clean transitions because the topic sounds complex — complexity alone is not risk.
- Missing metric gaming: rushed closures, unnecessary recategorization, avoided escalations that serve the agent's stats rather than the customer.
- Accepting a resolution that followed correct procedure when the procedure itself was wrong for this case.
