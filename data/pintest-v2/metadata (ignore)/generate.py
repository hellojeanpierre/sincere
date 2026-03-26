#!/usr/bin/env python3
"""
Synthetic Pinterest Support Ticket Generator
=============================================
Produces realistic Zendesk-shaped support tickets seeded from real research,
with injected failure modes for testing Sincere AI's investigation pipeline.

Tiers:
  - smoke   (30):  Quick validation — happy path + single-ticket failures
  - integration (150): Full pipeline — adds multi-ticket pattern failures
  - stress  (500): Realistic distribution with agent cohorts and seasonal patterns

Each ticket has:
  - Full Zendesk schema fields
  - Realistic Pinterest custom fields
  - Ground-truth labels (never visible to the system under test)
"""

import json
import random
import hashlib
import argparse
from datetime import datetime, timedelta, timezone
from copy import deepcopy
from typing import Optional

# ─────────────────────────────────────────────
# SEED DATA (extracted from CoWork research)
# ─────────────────────────────────────────────

ACCOUNT_TYPES = ["personal", "business", "advertiser", "creator", "merchant"]
PLATFORMS = ["ios", "android", "web_desktop", "web_mobile"]
CONTENT_TYPES = ["standard_pin", "video_pin", "idea_pin", "product_pin", "carousel", "ad", "board", "profile", "collage"]
BROWSERS = ["chrome", "safari", "firefox", "edge", "samsung_internet", None]
LANGUAGES = ["en", "es", "de", "fr", "pt", "ja", "ko", "it", "nl"]
COUNTRIES = ["US", "UK", "DE", "FR", "BR", "JP", "KR", "IT", "NL", "CA", "AU", "IN", "MX"]
AD_SPEND_TIERS = [None, "under_1k", "1k_10k", "10k_100k", "100k_plus"]
BPO_PARTNERS = ["partner_a", "partner_b", "partner_c"]
ESCALATION_LEVELS = ["tier_1", "tier_2", "tier_3"]

# Real issue categories from research
ISSUE_CATEGORIES = {
    "account_access": {
        "subcategories": ["account_suspended", "login_issues", "2fa_issues", "account_recovery", "account_locked"],
        "weight": 0.22,
        "typical_account_types": ["personal", "business", "creator"],
    },
    "content_moderation": {
        "subcategories": ["pin_removed", "board_removed", "ai_mislabel", "false_positive_flag", "spam_flag", "appeal_denied"],
        "weight": 0.20,
        "typical_account_types": ["personal", "creator", "business"],
    },
    "ads_billing": {
        "subcategories": ["ad_rejected", "ad_account_suspended", "billing_dispute", "campaign_not_delivering",
                          "targeting_issues", "conversion_tracking", "ad_review_delay", "unauthorized_charge"],
        "weight": 0.18,
        "typical_account_types": ["advertiser", "business"],
    },
    "shopping_merchant": {
        "subcategories": ["catalog_feed_error", "product_pin_rejected", "merchant_verification",
                          "rich_pin_issues", "inventory_sync", "shopping_feature_bug"],
        "weight": 0.10,
        "typical_account_types": ["merchant", "business"],
    },
    "algorithm_reach": {
        "subcategories": ["reach_drop", "deindexed_content", "analytics_broken", "feed_quality", "impressions_zero"],
        "weight": 0.10,
        "typical_account_types": ["creator", "business", "merchant"],
    },
    "spam_scam": {
        "subcategories": ["spam_report", "fake_merchant", "phishing_link", "scam_ads", "bot_activity"],
        "weight": 0.08,
        "typical_account_types": ["personal", "business"],
    },
    "technical_bug": {
        "subcategories": ["app_crash", "feature_not_working", "display_issues", "notification_issues",
                          "sync_issues", "api_issues"],
        "weight": 0.07,
        "typical_account_types": ["personal", "creator", "merchant"],
    },
    "privacy_legal": {
        "subcategories": ["data_request", "gdpr_request", "dsa_request", "privacy_concern", "copyright_claim", "trademark_claim"],
        "weight": 0.05,
        "typical_account_types": ["personal", "business"],
    },
}

# Realistic complaint templates seeded from research
COMPLAINT_TEMPLATES = {
    "account_suspended": [
        {
            "subject": "Account suspended with no explanation",
            "description": "My Pinterest account was suddenly suspended. I've had this account for {years} years and never violated any guidelines. The suspension notice says 'activity that violates spam guidelines' but I've never used bots or automation. I need my account back — I have {boards} boards with years of saved content.",
            "vars": {"years": (2, 10), "boards": (5, 50)},
        },
        {
            "subject": "Wrongful suspension — need immediate help",
            "description": "I woke up to find my account suspended. I run a legitimate {business_type} business and use Pinterest for inspiration boards. No warning, no specifics about what I did wrong. My appeal was denied within hours with a generic template response. This is affecting my business.",
            "vars": {"business_type": ["interior design", "wedding planning", "floral arrangement", "home staging", "fashion"]},
        },
        {
            "subject": "Account suspended during identity verification",
            "description": "I was in the middle of verifying my identity when my account got suspended. I uploaded my ID as requested but then the account was flagged. The verification process seems to have triggered the suspension. I can't log in and can't complete verification. Catch-22.",
            "vars": {},
        },
    ],
    "login_issues": [
        {
            "subject": "Can't log in — password reset not working",
            "description": "I'm trying to log into my Pinterest account but my password isn't working. I've attempted password reset {attempts} times but never receive the reset email. I've checked spam folders. The email on file is correct ({email_domain}). I'm locked out completely.",
            "vars": {"attempts": (3, 15), "email_domain": ["gmail.com", "outlook.com", "yahoo.com", "icloud.com"]},
        },
    ],
    "2fa_issues": [
        {
            "subject": "2FA codes not arriving — locked out",
            "description": "I enabled two-factor authentication on my account. Now when I try to log in, the SMS code never arrives. I've waited {wait_time} minutes multiple times. My phone number is correct. I have no backup codes. I need an alternative way to access my account.",
            "vars": {"wait_time": (5, 30)},
        },
    ],
    "ai_mislabel": [
        {
            "subject": "My original artwork flagged as AI-generated",
            "description": "My {art_type} has been labeled as 'AI modified' on Pinterest. I created this work {years} years ago, well before AI image generators existed. I'm a professional {profession} and this is my livelihood. The mislabel is suppressing my content in search. There's no clear way to challenge this.",
            "vars": {
                "art_type": ["hand-drawn illustration", "digital painting", "watercolor scan", "oil painting photograph", "charcoal sketch"],
                "years": (3, 13),
                "profession": ["illustrator", "graphic designer", "fine artist", "concept artist", "photographer"],
            },
        },
    ],
    "false_positive_flag": [
        {
            "subject": "Legitimate content removed — false flag",
            "description": "My pin showing {content_desc} was removed for violating community guidelines. The pin has been up for {months} months with no issues. It's clearly not violating any policy — it's {defense}. I've appealed but received a template denial. This is the {ordinal} time this has happened.",
            "vars": {
                "content_desc": ["home renovation progress", "a recipe with raw ingredients", "my garden plants", "a craft tutorial", "professional headshots"],
                "months": (1, 24),
                "defense": ["educational content", "original photography", "a standard tutorial", "completely safe for work"],
                "ordinal": ["second", "third", "fourth"],
            },
        },
    ],
    "ad_rejected": [
        {
            "subject": "Promoted pin rejected — unclear reason",
            "description": "My promoted pin for {product_type} was rejected. The rejection email says '{rejection_reason}' but I've reviewed the advertising guidelines and can't identify the issue. The pin shows {pin_desc}. Campaign ID: c_{campaign_id}. I need this running for {event}.",
            "vars": {
                "product_type": ["organic skincare", "handmade jewelry", "fitness equipment", "children's books", "home decor"],
                "rejection_reason": ["misleading claims", "unacceptable content", "policy violation", "restricted content"],
                "pin_desc": ["a product photo on white background", "a lifestyle image", "a before/after comparison", "product packaging"],
                "campaign_id": (100000, 999999),
                "event": ["our spring launch", "Black Friday", "the holiday season", "a product drop next week"],
            },
        },
    ],
    "billing_dispute": [
        {
            "subject": "Charged {amount} for ads that never ran",
            "description": "I was charged ${amount} on {date_ref} for a campaign that shows zero impressions and zero clicks in my dashboard. The campaign was set to {budget}/day but the ads were never approved. I need a refund. Ad account ID: {ad_id}.",
            "vars": {
                "amount": (50, 5000),
                "date_ref": ["March 15", "last Tuesday", "two weeks ago", "the 1st of this month"],
                "budget": (10, 500),
                "ad_id": (500000000, 599999999),
            },
        },
    ],
    "unauthorized_charge": [
        {
            "subject": "Unauthorized charge on my card from Pinterest Ads",
            "description": "I found a charge of ${amount} from Pinterest on my credit card statement. I paused all campaigns {when} and my daily budget was only ${budget}. I did not authorize this charge. I need an immediate refund and an explanation of how this happened.",
            "vars": {
                "amount": (100, 8000),
                "when": ["two weeks ago", "last month", "in January"],
                "budget": (10, 100),
            },
        },
    ],
    "catalog_feed_error": [
        {
            "subject": "Catalog feed failing — products not syncing",
            "description": "My product catalog has been failing to sync for {days} days. The error message says '{error}' but my feed URL is valid and returns correct data when I test it. I have {products} products that aren't appearing on Pinterest. This is costing me sales.",
            "vars": {
                "days": (2, 14),
                "error": ["Invalid feed format", "Feed URL not responding", "Missing required fields", "Processing error"],
                "products": (50, 5000),
            },
        },
    ],
    "merchant_verification": [
        {
            "subject": "Merchant verification denied — no reason given",
            "description": "I applied for verified merchant status {weeks} weeks ago. My application was denied with no specific reason. I meet all the requirements: I have a {platform} store with {products} products, my domain is claimed, and I have all required meta tags. What am I missing?",
            "vars": {
                "weeks": (2, 8),
                "platform": ["Shopify", "WooCommerce", "BigCommerce", "Magento"],
                "products": (20, 2000),
            },
        },
    ],
    "rich_pin_issues": [
        {
            "subject": "Rich pins validation failing — need technical help",
            "description": "I'm trying to set up rich pins but the validation tool says '{error}' without specifying which tags are wrong. I've added schema.org product markup. The metadata looks correct when I inspect it. I've re-validated {attempts} times. I need rich pins for merchant verification.",
            "vars": {
                "error": ["Invalid meta tags", "Unable to parse metadata", "Missing required fields"],
                "attempts": (3, 20),
            },
        },
    ],
    "reach_drop": [
        {
            "subject": "Impressions dropped {percent}% overnight — what happened?",
            "description": "My pin impressions dropped from {before} to {after} monthly views in the last 48 hours with no changes on my end. I have {followers} followers and have been consistent with posting. Did something change with the algorithm? My content hasn't changed.",
            "vars": {
                "percent": (50, 90),
                "before": (10000, 500000),
                "after": (500, 50000),
                "followers": (1000, 100000),
            },
        },
    ],
    "impressions_zero": [
        {
            "subject": "Analytics showing zero across all pins",
            "description": "All of my pins are suddenly showing 0 impressions, 0 saves, 0 clicks. This started {when}. My analytics were working fine before. I have {followers} followers and usually get {monthly} monthly viewers. Everything shows 0. Is this a bug?",
            "vars": {
                "when": ["yesterday", "two days ago", "since the weekend"],
                "followers": (5000, 200000),
                "monthly": (10000, 500000),
            },
        },
    ],
    "spam_flag": [
        {
            "subject": "Account flagged as spam — I'm not a spammer",
            "description": "My account was flagged as spam today. My pins aren't showing up in searches. I've been on Pinterest for {years} years with legitimate content about {topic}. I've never used bots or automation. I sent an appeal but haven't heard back.",
            "vars": {
                "years": (3, 12),
                "topic": ["interior design", "travel photography", "cooking recipes", "gardening", "DIY crafts", "fashion"],
            },
        },
    ],
    "fake_merchant": [
        {
            "subject": "Scam seller on Pinterest — bought fake product",
            "description": "I purchased a {product} through a Pinterest shopping link. The product that arrived is a cheap counterfeit. The seller '{seller}' has multiple complaints. I paid ${amount} and want a refund. Pinterest promoted this seller in my feed.",
            "vars": {
                "product": ["Italian leather bag", "designer watch", "cashmere sweater", "handmade jewelry", "silk scarf"],
                "seller": ["LuxuryFinds_Shop", "BestDeals247", "TrendyGiftsOnline", "PremiumGoods_Store"],
                "amount": (30, 300),
            },
        },
    ],
    "gdpr_request": [
        {
            "subject": "GDPR data deletion request",
            "description": "Under GDPR Article 17, I request the complete deletion of all personal data associated with my Pinterest account (username: @{username}). This includes all pins, boards, analytics data, advertising data, and any derived profiles. Please confirm deletion within 30 days.",
            "vars": {
                "username": ["user_" + str(i) for i in range(100, 200)],
            },
        },
    ],
    "app_crash": [
        {
            "subject": "App crashing on {action}",
            "description": "The Pinterest app crashes every time I try to {action}. I'm on {device} running {os}. App version {version}. I've tried reinstalling and clearing cache. The issue started {when}. The app was working fine before that.",
            "vars": {
                "action": ["open a pin", "save to a board", "search anything", "view my profile", "upload a pin", "open notifications"],
                "device": ["iPhone 15", "iPhone 14", "Samsung Galaxy S24", "Pixel 8", "iPad Pro"],
                "os": ["iOS 18.3", "iOS 17.6", "Android 15", "Android 14", "iPadOS 18"],
                "version": ["11.45", "11.44", "11.43", "11.42"],
                "when": ["after the last update", "yesterday", "three days ago", "this morning"],
            },
        },
    ],
    # Catch-all for subcategories without explicit templates
    "_default": [
        {
            "subject": "Issue with my Pinterest account — {subcategory}",
            "description": "I'm experiencing a problem with {subcategory} on my Pinterest account. I've been using Pinterest for {years} years. This started {when}. I've tried the help center articles but they don't address my specific situation. I need human help.",
            "vars": {
                "years": (1, 10),
                "when": ["recently", "last week", "a few days ago", "today"],
            },
        },
    ],
}

# Agent response templates (for injecting quality signals)
AGENT_RESPONSES = {
    "template_good": [
        "I've reviewed your account and identified the issue — it was caused by a recent platform update that affected your settings. I've applied the fix on our end and everything should be back to normal within a few hours.",
        "After investigating your case, I found the root cause on our side. I've corrected the configuration and verified the fix is working. You should see the change reflected in your account shortly.",
        "I looked into this and traced the problem to a system-side error that affected your account. I've resolved it and confirmed the fix. Please allow up to 24 hours for the changes to fully propagate.",
        "I've completed a thorough review of your case and applied the necessary corrections. The issue was on our end and has been fixed. Your account should be functioning normally now.",
        "I investigated your report and found the underlying cause. I've escalated the fix to our specialized team and they've confirmed the resolution. You should see everything working correctly within the next few hours.",
        "After reviewing your account details and the reported issue, I've identified and resolved the problem. The fix has been applied and verified. Let us know if you notice any further issues.",
    ],
    "template_canned": [
        "Thank you for contacting Pinterest Support. For your issue, please visit our help center at help.pinterest.com for detailed guidance on this topic.",
        "We've reviewed your account and determined that the action taken was in accordance with our Community Guidelines. You can review our policies at policy.pinterest.com.",
        "Thanks for reaching out. We understand this is frustrating. Please try clearing your cache and reinstalling the app. If the issue persists, let us know.",
    ],
    "template_misrouted": [
        "Thank you for your billing inquiry. Our ads team will review your campaign performance. Please allow 5-10 business days.",
        "We've forwarded your content moderation concern to our Trust & Safety team. They'll review your account status.",
    ],
}

# ─────────────────────────────────────────────
# FAILURE MODE DEFINITIONS
# ─────────────────────────────────────────────

FAILURE_MODES = {
    # Single-ticket failures (detectable within one ticket)
    "premature_closure": {
        "type": "single",
        "description": "Agent closes ticket with template response, short handle time, no investigation",
        "signals": {
            "handle_time_minutes": (1, 3),
            "agent_response_type": "template_canned",
            "resolution_quality": "poor",
            "replies_count": 1,
            "reopened": False,
        },
    },
    "miscategorized": {
        "type": "single",
        "description": "Agent selects wrong issue category/subcategory — right team, wrong classification",
        "signals": {
            "category_mismatch": True,
            "resolution_quality": "poor",
        },
    },
    "misrouted": {
        "type": "single",
        "description": "Ticket sent to wrong team entirely",
        "signals": {
            "group_mismatch": True,
            "reassignment_count": (1, 3),
            "first_reply_time_hours": (48, 120),
        },
    },
    "copy_paste_sop": {
        "type": "single",
        "description": "Correct SOP selected but applied to wrong situation",
        "signals": {
            "handle_time_minutes": (2, 5),
            "agent_response_type": "template_canned",
            "sop_mismatch": True,
            "resolution_quality": "poor",
        },
    },
    "escalation_avoidance": {
        "type": "single",
        "description": "Agent attempts fix outside scope to avoid escalation metric hit",
        "signals": {
            "should_have_escalated": True,
            "escalated": False,
            "handle_time_minutes": (10, 25),
            "resolution_quality": "poor",
        },
    },
    # Multi-ticket failures (require patterns across tickets)
    "gaming_metrics": {
        "type": "multi",
        "pattern": "reopen_pair",
        "description": "Ticket closed prematurely, customer reopens within 48h about same issue",
        "signals": {
            "first_ticket": {
                "handle_time_minutes": (1, 3),
                "agent_response_type": "template_canned",
                "csat_score": "good",  # gamed
                "status": "solved",
            },
            "followup_ticket": {
                "is_followup": True,
                "days_after": (1, 3),
                "same_issue": True,
                "customer_frustration": "high",
            },
        },
    },
    "sop_outdated": {
        "type": "multi",
        "pattern": "cluster",
        "cluster_size": (4, 8),
        "description": "Multiple tickets fail the same way because the SOP is wrong/outdated",
        "signals": {
            "same_subcategory": True,
            "same_resolution_failure": True,
            "different_agents": True,
        },
    },
    "training_gap": {
        "type": "multi",
        "pattern": "agent_cohort",
        "description": "New agents cluster on the same mistake; tenured agents don't",
        "signals": {
            "agent_tenure": "new",
            "same_error_pattern": True,
            "experienced_agents_succeed": True,
        },
    },
    "policy_conflict": {
        "type": "multi",
        "pattern": "cluster",
        "cluster_size": (3, 5),
        "description": "Two SOPs contradict each other for edge cases",
        "signals": {
            "contradictory_resolutions": True,
            "same_issue_type": True,
            "different_outcomes": True,
        },
    },
}

# ─────────────────────────────────────────────
# AGENT POOL (for multi-ticket patterns)
# ─────────────────────────────────────────────

def generate_agent_pool(n=25):
    """Generate a pool of agents with tenure and performance characteristics."""
    agents = []
    for i in range(n):
        tenure_months = random.choice(
            [random.randint(1, 4)] * 8 +  # 8 new agents
            [random.randint(5, 12)] * 10 +  # 10 mid-tenure
            [random.randint(13, 36)] * 7    # 7 experienced
        )
        agents.append({
            "agent_id": 1200000 + i,
            "agent_name": f"agent_{i:03d}",
            "bpo_partner": random.choice(BPO_PARTNERS),
            "tenure_months": tenure_months,
            "tenure_bucket": "new" if tenure_months <= 4 else ("mid" if tenure_months <= 12 else "experienced"),
            "quality_score": min(1.0, max(0.3, 0.5 + tenure_months * 0.015 + random.gauss(0, 0.1))),
        })
    return agents


# ─────────────────────────────────────────────
# TICKET GENERATOR
# ─────────────────────────────────────────────

class TicketGenerator:
    def __init__(self, seed=42):
        random.seed(seed)
        self.agents = generate_agent_pool()
        self.ticket_counter = 4800000
        self.user_counter = 8800000
        self.generated_tickets = []

    def _next_ticket_id(self):
        self.ticket_counter += random.randint(1, 5)
        return self.ticket_counter

    def _next_user_id(self):
        self.user_counter += 1
        return self.user_counter

    def _pick_category(self):
        """Weighted random category selection matching real distribution."""
        cats = list(ISSUE_CATEGORIES.keys())
        weights = [ISSUE_CATEGORIES[c]["weight"] for c in cats]
        return random.choices(cats, weights=weights, k=1)[0]

    def _pick_subcategory(self, category):
        return random.choice(ISSUE_CATEGORIES[category]["subcategories"])

    def _pick_agent(self, tenure_filter=None):
        pool = self.agents
        if tenure_filter:
            pool = [a for a in self.agents if a["tenure_bucket"] == tenure_filter]
            if not pool:
                pool = self.agents
        return random.choice(pool)

    def _render_template(self, subcategory):
        """Pick and render a complaint template with variable substitution."""
        templates = COMPLAINT_TEMPLATES.get(subcategory, COMPLAINT_TEMPLATES["_default"])
        template = random.choice(templates)

        subject = template["subject"]
        description = template["description"]
        rendered_vars = {}

        for var_name, var_spec in template.get("vars", {}).items():
            if isinstance(var_spec, tuple) and len(var_spec) == 2 and isinstance(var_spec[0], int):
                val = random.randint(var_spec[0], var_spec[1])
                rendered_vars[var_name] = str(val)
            elif isinstance(var_spec, list):
                rendered_vars[var_name] = random.choice(var_spec)
            else:
                rendered_vars[var_name] = str(var_spec)

        # Also make subcategory available for _default templates
        rendered_vars["subcategory"] = subcategory.replace("_", " ")

        try:
            subject = subject.format(**rendered_vars)
            description = description.format(**rendered_vars)
        except KeyError:
            pass  # Some templates may not use all vars

        return subject, description

    def _base_timestamp(self, days_ago=None):
        base = datetime(2026, 3, 20, tzinfo=timezone.utc)
        if days_ago is None:
            days_ago = random.randint(0, 60)
        offset = timedelta(
            days=-days_ago,
            hours=random.randint(6, 22),
            minutes=random.randint(0, 59),
        )
        return base + offset

    def generate_ticket(
        self,
        category=None,
        subcategory=None,
        failure_mode=None,
        agent=None,
        account_type=None,
        created_at=None,
        user_id=None,
        is_followup_of=None,
        override_fields=None,
    ):
        """Generate a single realistic Zendesk ticket."""
        if category is None:
            category = self._pick_category()
        if subcategory is None:
            subcategory = self._pick_subcategory(category)
        if account_type is None:
            account_type = random.choice(ISSUE_CATEGORIES[category]["typical_account_types"])
        if agent is None:
            agent = self._pick_agent()
        if created_at is None:
            created_at = self._base_timestamp()
        if user_id is None:
            user_id = self._next_user_id()

        ticket_id = self._next_ticket_id()
        subject, description = self._render_template(subcategory)

        # Followup tickets reference the original
        if is_followup_of:
            original = is_followup_of
            description = f"I'm writing again about my previous ticket (#{original['id']}). {description} This is extremely frustrating — my first ticket was closed without actually resolving anything."
            subject = f"RE: {original['subject']}"
            user_id = original["requester_id"]
            account_type = original["custom_fields_decoded"]["account_type"]

        platform = random.choice(PLATFORMS)
        is_advertiser = account_type in ("advertiser", "business")
        is_merchant = account_type == "merchant"
        is_creator = account_type == "creator"
        country = random.choice(COUNTRIES)
        language = "en" if country in ("US", "UK", "CA", "AU") else random.choice(LANGUAGES)

        # Handle time and reply behavior
        handle_time_minutes = random.randint(4, 20)
        first_reply_time_hours = random.randint(4, 72)
        replies_count = random.randint(1, 4)
        reopened = random.random() < 0.08
        escalated = random.random() < 0.12
        csat_score = random.choice(["good", "good", "bad", "bad", "bad", None, None])

        # Status
        status_weights = {"solved": 0.55, "pending": 0.15, "open": 0.15, "closed": 0.10, "hold": 0.05}
        status = random.choices(list(status_weights.keys()), weights=list(status_weights.values()), k=1)[0]

        # Agent response
        agent_response = random.choice(AGENT_RESPONSES["template_good"] + AGENT_RESPONSES["template_canned"])

        # Priority
        priority = "normal"
        if is_advertiser and category == "ads_billing":
            priority = random.choice(["high", "urgent", "high"])
        elif category == "privacy_legal":
            priority = "high"
        elif category == "account_access":
            priority = random.choice(["normal", "high"])

        # Failure mode injection
        ground_truth = {
            "failure_mode": None,
            "failure_type": None,
            "failure_description": None,
            "is_followup": is_followup_of is not None,
            "original_ticket_id": is_followup_of["id"] if is_followup_of else None,
            "actual_category": category,
            "actual_subcategory": subcategory,
            "agent_tenure_bucket": agent["tenure_bucket"],
        }

        # Apply failure mode signals
        labeled_category = category
        labeled_subcategory = subcategory
        assigned_group = self._category_to_group(category)

        if failure_mode:
            fm = FAILURE_MODES[failure_mode]
            ground_truth["failure_mode"] = failure_mode
            ground_truth["failure_type"] = fm["type"]
            ground_truth["failure_description"] = fm["description"]

            if failure_mode == "premature_closure":
                handle_time_minutes = random.randint(1, 3)
                agent_response = random.choice(AGENT_RESPONSES["template_canned"])
                replies_count = 1
                status = "solved"

            elif failure_mode == "miscategorized":
                wrong_cats = [c for c in ISSUE_CATEGORIES if c != category]
                labeled_category = random.choice(wrong_cats)
                labeled_subcategory = random.choice(ISSUE_CATEGORIES[labeled_category]["subcategories"])
                ground_truth["labeled_category"] = labeled_category
                ground_truth["labeled_subcategory"] = labeled_subcategory

            elif failure_mode == "misrouted":
                wrong_cats = [c for c in ISSUE_CATEGORIES if c != category]
                wrong_group = self._category_to_group(random.choice(wrong_cats))
                assigned_group = wrong_group
                first_reply_time_hours = random.randint(48, 120)
                ground_truth["wrong_group"] = assigned_group

            elif failure_mode == "copy_paste_sop":
                handle_time_minutes = random.randint(2, 5)
                agent_response = random.choice(AGENT_RESPONSES["template_canned"])
                ground_truth["sop_applied"] = "wrong_sop"

            elif failure_mode == "escalation_avoidance":
                escalated = False
                handle_time_minutes = random.randint(10, 25)
                ground_truth["should_have_escalated"] = True

            elif failure_mode == "gaming_metrics":
                handle_time_minutes = random.randint(1, 3)
                agent_response = random.choice(AGENT_RESPONSES["template_canned"])
                csat_score = "good"
                status = "solved"

        # Determine ad spend tier
        ad_spend = None
        if is_advertiser:
            ad_spend = random.choice(["1k_10k", "10k_100k", "100k_plus", "under_1k"])

        # Build custom fields decoded (human-readable for ground truth / debugging)
        custom_fields_decoded = {
            "account_type": account_type,
            "platform": platform,
            "issue_category": labeled_category,
            "issue_subcategory": labeled_subcategory,
            "content_type": random.choice(CONTENT_TYPES) if category == "content_moderation" else None,
            "is_advertiser": is_advertiser,
            "is_verified_merchant": is_merchant and random.random() < 0.4,
            "is_creator": is_creator,
            "monthly_ad_spend_tier": ad_spend,
            "account_country": country,
            "account_language": language,
            "bpo_partner": agent["bpo_partner"],
            "escalation_level": "tier_2" if escalated else "tier_1",
            "contact_reason_l1": labeled_category,
            "contact_reason_l2": labeled_subcategory,
        }

        updated_at = created_at + timedelta(hours=first_reply_time_hours, minutes=random.randint(0, 59))

        tags = [
            f"{labeled_category}_routed",
            platform.split("_")[0],
            agent["bpo_partner"],
        ]
        if is_advertiser:
            tags.append("advertiser")
        if ad_spend == "100k_plus":
            tags.append("high_value_advertiser")
        if escalated:
            tags.append("escalated")
        if category == "content_moderation":
            tags.append("appeal")

        ticket = {
            # ── Zendesk system fields ──
            "id": ticket_id,
            "url": f"https://pinterest.zendesk.com/api/v2/tickets/{ticket_id}.json",
            "external_id": f"drupal_sub_{random.randint(10000, 99999)}",
            "subject": subject,
            "description": description,
            "type": random.choice(["question", "incident", "problem"]),
            "status": status,
            "priority": priority,
            "requester_id": user_id,
            "submitter_id": user_id,
            "assignee_id": agent["agent_id"],
            "organization_id": random.randint(90000, 99999) if is_advertiser else None,
            "group_id": assigned_group,
            "brand_id": 360001111111,
            "ticket_form_id": self._category_to_form(category),
            "collaborator_ids": [],
            "follower_ids": [agent["agent_id"]] if escalated else [],
            "tags": tags,
            "custom_fields_decoded": custom_fields_decoded,
            "via": {
                "channel": "api",
                "source": {"from": {}, "rel": "drupal_help_center"},
            },
            "created_at": created_at.isoformat(),
            "updated_at": updated_at.isoformat(),
            "satisfaction_rating": {"score": csat_score} if csat_score else None,
            "from_messaging_channel": False,

            # ── Operational metrics ──
            "metrics": {
                "handle_time_minutes": handle_time_minutes,
                "first_reply_time_hours": first_reply_time_hours,
                "replies_count": replies_count,
                "reopened": reopened,
                "escalated": escalated,
                "reassignment_count": random.randint(1, 3) if failure_mode == "misrouted" else 0,
            },

            # ── Agent info ──
            "agent": {
                "agent_id": agent["agent_id"],
                "agent_name": agent["agent_name"],
                "bpo_partner": agent["bpo_partner"],
                "tenure_months": agent["tenure_months"],
                "tenure_bucket": agent["tenure_bucket"],
            },

            # ── Agent response (what the system sees) ──
            "agent_response_summary": agent_response,

            # ── GROUND TRUTH (evaluation only — not visible to system under test) ──
            "_ground_truth": ground_truth,
        }

        if override_fields:
            ticket.update(override_fields)

        self.generated_tickets.append(ticket)
        return ticket

    def _category_to_group(self, category):
        groups = {
            "account_access": 360001000001,
            "content_moderation": 360001000002,
            "ads_billing": 360001000003,
            "shopping_merchant": 360001000004,
            "algorithm_reach": 360001000005,
            "spam_scam": 360001000006,
            "technical_bug": 360001000007,
            "privacy_legal": 360001000008,
        }
        return groups.get(category, 360001000001)

    def _category_to_form(self, category):
        forms = {
            "account_access": 360002000001,
            "content_moderation": 360002000002,
            "ads_billing": 360002000003,
            "shopping_merchant": 360002000004,
            "algorithm_reach": 360002000005,
            "spam_scam": 360002000006,
            "technical_bug": 360002000007,
            "privacy_legal": 360002000008,
        }
        return forms.get(category, 360002000001)

    # ── Multi-ticket pattern generators ──

    def generate_gaming_pair(self, **kwargs):
        """Generate a gamed ticket + its followup reopen."""
        agent = self._pick_agent()
        category = kwargs.get("category", self._pick_category())
        subcategory = kwargs.get("subcategory", self._pick_subcategory(category))
        ts = self._base_timestamp()

        original = self.generate_ticket(
            category=category, subcategory=subcategory,
            agent=agent, failure_mode="gaming_metrics", created_at=ts,
        )
        followup = self.generate_ticket(
            category=category, subcategory=subcategory,
            agent=self._pick_agent(),  # different agent on reopen
            failure_mode=None,
            created_at=ts + timedelta(days=random.randint(1, 3)),
            is_followup_of=original,
        )
        followup["_ground_truth"]["failure_mode"] = "gaming_metrics_followup"
        followup["_ground_truth"]["failure_type"] = "multi"
        followup["_ground_truth"]["paired_with"] = original["id"]
        original["_ground_truth"]["paired_with"] = followup["id"]

        return [original, followup]

    def generate_sop_outdated_cluster(self, cluster_size=None, **kwargs):
        """Generate a cluster of tickets that all fail the same way due to outdated SOP."""
        if cluster_size is None:
            cluster_size = random.randint(4, 8)
        category = kwargs.get("category", random.choice(["content_moderation", "ads_billing", "account_access"]))
        subcategory = kwargs.get("subcategory", self._pick_subcategory(category))
        base_ts = self._base_timestamp(days_ago=random.randint(5, 30))
        cluster_id = hashlib.md5(f"sop_outdated_{category}_{subcategory}_{base_ts}".encode()).hexdigest()[:8]

        tickets = []
        for i in range(cluster_size):
            agent = self._pick_agent()  # different agents
            t = self.generate_ticket(
                category=category, subcategory=subcategory,
                agent=agent, failure_mode="copy_paste_sop",
                created_at=base_ts + timedelta(days=random.randint(0, 7), hours=random.randint(0, 12)),
            )
            t["_ground_truth"]["failure_mode"] = "sop_outdated"
            t["_ground_truth"]["cluster_id"] = cluster_id
            t["_ground_truth"]["cluster_size"] = cluster_size
            tickets.append(t)
        return tickets

    def generate_training_gap_cohort(self, cohort_size=None, **kwargs):
        """Generate tickets where new agents fail but experienced agents succeed on the same issue."""
        if cohort_size is None:
            cohort_size = random.randint(4, 8)
        category = kwargs.get("category", self._pick_category())
        subcategory = kwargs.get("subcategory", self._pick_subcategory(category))
        base_ts = self._base_timestamp(days_ago=random.randint(3, 20))
        cohort_id = hashlib.md5(f"training_gap_{category}_{subcategory}_{base_ts}".encode()).hexdigest()[:8]

        tickets = []
        # New agents failing
        n_failing = max(2, cohort_size - 2)
        for i in range(n_failing):
            agent = self._pick_agent(tenure_filter="new")
            t = self.generate_ticket(
                category=category, subcategory=subcategory,
                agent=agent, failure_mode="premature_closure",
                created_at=base_ts + timedelta(days=random.randint(0, 5)),
            )
            t["_ground_truth"]["failure_mode"] = "training_gap"
            t["_ground_truth"]["failure_type"] = "multi"
            t["_ground_truth"]["cohort_id"] = cohort_id
            t["_ground_truth"]["cohort_role"] = "failing_new_agent"
            tickets.append(t)

        # Experienced agents succeeding
        for i in range(cohort_size - n_failing):
            agent = self._pick_agent(tenure_filter="experienced")
            t = self.generate_ticket(
                category=category, subcategory=subcategory,
                agent=agent, failure_mode=None,
                created_at=base_ts + timedelta(days=random.randint(0, 5)),
            )
            t["_ground_truth"]["failure_mode"] = "training_gap"
            t["_ground_truth"]["failure_type"] = "multi"
            t["_ground_truth"]["cohort_id"] = cohort_id
            t["_ground_truth"]["cohort_role"] = "succeeding_experienced_agent"
            tickets.append(t)

        return tickets

    def generate_policy_conflict_cluster(self, cluster_size=None, **kwargs):
        """Generate tickets where contradictory SOPs lead to different outcomes for same issue."""
        if cluster_size is None:
            cluster_size = random.randint(3, 5)
        category = kwargs.get("category", random.choice(["content_moderation", "ads_billing"]))
        subcategory = kwargs.get("subcategory", self._pick_subcategory(category))
        base_ts = self._base_timestamp(days_ago=random.randint(5, 25))
        cluster_id = hashlib.md5(f"policy_conflict_{category}_{subcategory}_{base_ts}".encode()).hexdigest()[:8]

        tickets = []
        for i in range(cluster_size):
            agent = self._pick_agent()
            t = self.generate_ticket(
                category=category, subcategory=subcategory,
                agent=agent, failure_mode=None,
                created_at=base_ts + timedelta(days=random.randint(0, 10)),
            )
            # Alternate outcomes to show contradiction
            outcome = "approved" if i % 2 == 0 else "denied"
            t["_ground_truth"]["failure_mode"] = "policy_conflict"
            t["_ground_truth"]["failure_type"] = "multi"
            t["_ground_truth"]["cluster_id"] = cluster_id
            t["_ground_truth"]["contradictory_outcome"] = outcome
            t["metrics"]["handle_time_minutes"] = random.randint(5, 15)
            tickets.append(t)

        return tickets


# ─────────────────────────────────────────────
# TIER BUILDERS
# ─────────────────────────────────────────────

def build_smoke(gen: TicketGenerator) -> list:
    """30 tickets: 20 clean + 10 single-ticket failures."""
    tickets = []

    # 20 clean tickets across categories
    for _ in range(20):
        tickets.append(gen.generate_ticket())

    # 10 single-ticket failures (2 of each type)
    single_failures = ["premature_closure", "miscategorized", "misrouted", "copy_paste_sop", "escalation_avoidance"]
    for fm in single_failures:
        for _ in range(2):
            tickets.append(gen.generate_ticket(failure_mode=fm))

    random.shuffle(tickets)
    return tickets


def build_integration(gen: TicketGenerator) -> list:
    """150 tickets: 80 clean + 40 single-ticket + 30 multi-ticket patterns."""
    tickets = []

    # 80 clean
    for _ in range(80):
        tickets.append(gen.generate_ticket())

    # 40 single-ticket failures (8 each)
    single_failures = ["premature_closure", "miscategorized", "misrouted", "copy_paste_sop", "escalation_avoidance"]
    for fm in single_failures:
        for _ in range(8):
            tickets.append(gen.generate_ticket(failure_mode=fm))

    # ~30 multi-ticket patterns
    # 3 gaming pairs = 6 tickets
    for _ in range(3):
        tickets.extend(gen.generate_gaming_pair())

    # 2 SOP-outdated clusters of ~5 = ~10 tickets
    for _ in range(2):
        tickets.extend(gen.generate_sop_outdated_cluster(cluster_size=5))

    # 1 training gap cohort of ~6 = 6 tickets
    tickets.extend(gen.generate_training_gap_cohort(cohort_size=6))

    # 1 policy conflict cluster of ~4 = 4 tickets
    tickets.extend(gen.generate_policy_conflict_cluster(cluster_size=4))

    random.shuffle(tickets)
    return tickets


def build_stress(gen: TicketGenerator) -> list:
    """500 tickets: ~60% clean, ~25% single-ticket, ~15% multi-ticket."""
    tickets = []

    # ~300 clean
    for _ in range(300):
        tickets.append(gen.generate_ticket())

    # ~125 single-ticket failures (25 each)
    single_failures = ["premature_closure", "miscategorized", "misrouted", "copy_paste_sop", "escalation_avoidance"]
    for fm in single_failures:
        for _ in range(25):
            tickets.append(gen.generate_ticket(failure_mode=fm))

    # ~75 multi-ticket patterns
    # 8 gaming pairs = 16
    for _ in range(8):
        tickets.extend(gen.generate_gaming_pair())

    # 4 SOP-outdated clusters of ~6 = ~24
    for _ in range(4):
        tickets.extend(gen.generate_sop_outdated_cluster(cluster_size=6))

    # 3 training gap cohorts of ~6 = ~18
    for _ in range(3):
        tickets.extend(gen.generate_training_gap_cohort(cohort_size=6))

    # 3 policy conflict clusters of ~4 = ~12
    for _ in range(3):
        tickets.extend(gen.generate_policy_conflict_cluster(cluster_size=4))

    random.shuffle(tickets)
    return tickets


# ─────────────────────────────────────────────
# OUTPUT
# ─────────────────────────────────────────────

def write_dataset(tickets, path, include_ground_truth=True):
    """Write tickets as JSONL."""
    with open(path, "w") as f:
        for t in tickets:
            if not include_ground_truth:
                t = deepcopy(t)
                del t["_ground_truth"]
            f.write(json.dumps(t, default=str) + "\n")
    print(f"  Wrote {len(tickets)} tickets to {path}")


def write_summary(tickets, path):
    """Write a human-readable summary of dataset composition."""
    total = len(tickets)
    failure_counts = {}
    category_counts = {}
    multi_clusters = set()

    for t in tickets:
        gt = t["_ground_truth"]
        fm = gt.get("failure_mode") or "clean"
        failure_counts[fm] = failure_counts.get(fm, 0) + 1
        cat = gt.get("actual_category", "unknown")
        category_counts[cat] = category_counts.get(cat, 0) + 1
        if gt.get("cluster_id"):
            multi_clusters.add(gt["cluster_id"])
        if gt.get("cohort_id"):
            multi_clusters.add(gt["cohort_id"])

    with open(path, "w") as f:
        f.write(f"Dataset Summary\n{'='*50}\n")
        f.write(f"Total tickets: {total}\n\n")

        f.write("Failure Mode Distribution:\n")
        for fm, count in sorted(failure_counts.items(), key=lambda x: -x[1]):
            pct = count / total * 100
            f.write(f"  {fm:30s} {count:4d} ({pct:5.1f}%)\n")

        f.write(f"\nDistinct multi-ticket clusters/cohorts: {len(multi_clusters)}\n\n")

        f.write("Issue Category Distribution:\n")
        for cat, count in sorted(category_counts.items(), key=lambda x: -x[1]):
            pct = count / total * 100
            f.write(f"  {cat:30s} {count:4d} ({pct:5.1f}%)\n")

    print(f"  Wrote summary to {path}")


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic Pinterest support tickets")
    parser.add_argument("--tier", choices=["smoke", "integration", "stress", "all"], default="all")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="/mnt/user-data/outputs/synthetic-tickets")
    parser.add_argument("--no-ground-truth", action="store_true", help="Strip ground truth labels from output")
    args = parser.parse_args()

    import os
    os.makedirs(args.output_dir, exist_ok=True)

    tiers_to_build = ["smoke", "integration", "stress"] if args.tier == "all" else [args.tier]

    builders = {
        "smoke": build_smoke,
        "integration": build_integration,
        "stress": build_stress,
    }

    for tier in tiers_to_build:
        print(f"\nGenerating {tier} tier...")
        gen = TicketGenerator(seed=args.seed)
        tickets = builders[tier](gen)

        # Write both versions: with and without ground truth
        write_dataset(tickets, f"{args.output_dir}/{tier}_with_labels.jsonl", include_ground_truth=True)
        write_dataset(tickets, f"{args.output_dir}/{tier}_tickets.jsonl", include_ground_truth=not args.no_ground_truth)
        write_summary(tickets, f"{args.output_dir}/{tier}_summary.txt")

    print(f"\nDone. Output in {args.output_dir}/")


if __name__ == "__main__":
    main()
