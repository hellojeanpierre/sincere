#!/usr/bin/env python3
"""
Patch tickets with unresolved {root_cause} template placeholders.

These placeholders are data-generation artifacts — they don't come from
generate.py and aren't listed in Appendix C macros. Affected tickets have
other intended failure modes (misrouted, escalation_avoidance, etc.) whose
signals live in metadata, not response text.

Replaces with random picks from template_good + template_canned, matching
what generate.py assigns by default for these failure modes.

Run:  python3 data/pintest-v2/metadata/patch_placeholder_responses.py
"""

import json
import os
import random

random.seed(42)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..")

PLACEHOLDER_MARKER = "{root_cause}"

# Same pool generate.py draws from for failure modes that don't override agent_response
RESPONSE_POOL = [
    # template_good
    "I've reviewed your account and identified the issue — it was caused by a recent platform update that affected your settings. I've applied the fix on our end and everything should be back to normal within a few hours.",
    "After investigating your case, I found the root cause on our side. I've corrected the configuration and verified the fix is working. You should see the change reflected in your account shortly.",
    "I looked into this and traced the problem to a system-side error that affected your account. I've resolved it and confirmed the fix. Please allow up to 24 hours for the changes to fully propagate.",
    "I've completed a thorough review of your case and applied the necessary corrections. The issue was on our end and has been fixed. Your account should be functioning normally now.",
    "I investigated your report and found the underlying cause. I've escalated the fix to our specialized team and they've confirmed the resolution. You should see everything working correctly within the next few hours.",
    "After reviewing your account details and the reported issue, I've identified and resolved the problem. The fix has been applied and verified. Let us know if you notice any further issues.",
    # template_canned
    "Thank you for contacting Pinterest Support. For your issue, please visit our help center at help.pinterest.com for detailed guidance on this topic.",
    "We've reviewed your account and determined that the action taken was in accordance with our Community Guidelines. You can review our policies at policy.pinterest.com.",
    "Thanks for reaching out. We understand this is frustrating. Please try clearing your cache and reinstalling the app. If the issue persists, let us know.",
]

TICKET_FILES = [
    os.path.join(DATA_DIR, "smoke-tickets", "smoke_tickets.jsonl"),
    os.path.join(DATA_DIR, "integration-tickets", "integration_tickets.jsonl"),
    os.path.join(DATA_DIR, "stress-tickets", "stress_tickets.jsonl"),
]


def patch_file(path: str) -> int:
    patched = 0
    lines = []
    with open(path) as f:
        for line in f:
            ticket = json.loads(line)
            if PLACEHOLDER_MARKER in ticket.get("agent_response_summary", ""):
                ticket["agent_response_summary"] = random.choice(RESPONSE_POOL)
                patched += 1
            lines.append(json.dumps(ticket, ensure_ascii=False))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return patched


def main():
    total = 0
    for path in TICKET_FILES:
        name = os.path.basename(path)
        if not os.path.exists(path):
            print(f"  {name}: skipped (not found)")
            continue
        count = patch_file(path)
        total += count
        print(f"  {name}: {count} tickets patched")
    print(f"\nTotal: {total} tickets patched")


if __name__ == "__main__":
    main()
