#!/usr/bin/env python3
"""
Patch integration_tickets.jsonl: replace broken agent_response_summary
for all clean (pass) cases with realistic, subcategory-specific responses.

Run: python3 "data/pintest-v2/metadata (ignore)/patch_integration_responses.py"
"""

import json
import os
import random
import statistics

random.seed(42)

# ─────────────────────────────────────────────
# Per-subcategory response bank
# Each response mimics a real BPO agent resolving the ticket:
#   - states what they found (root cause)
#   - describes what action they took
#   - sets an expectation for the customer
# ─────────────────────────────────────────────

RESPONSE_BANK = {
    # ── account_access ──
    "account_locked": [
        "I've verified your identity using the email and phone number on file and unlocked your account. The lock was triggered by our automated security system after detecting login attempts from an unrecognized device in a different region. I've also cleared the security flag so you won't be locked out again from your usual devices.",
        "Your account was locked after five consecutive failed login attempts. I've confirmed your identity through our verification process and removed the lock. You should be able to log in now. I'd recommend updating your password from the account settings page as a precaution.",
        "I checked and the lock was caused by a session conflict — you were logged in on two devices simultaneously when one triggered a security check. I've cleared the session state and unlocked your account. Everything should be back to normal.",
        "After verifying your account details, I've removed the security hold. The lock was triggered by a VPN connection that our system flagged as suspicious. Your account is fully accessible now and I've added a note to prevent this from recurring with your typical connection pattern.",
        "Your account lock was caused by our brute-force protection system — it detected rapid login attempts from multiple IP addresses targeting your account. I've confirmed these weren't from you, reset the lockout counter, and restored access. I'd recommend enabling two-factor authentication for additional security.",
        "I traced the lock to a recent password change that didn't propagate correctly across our authentication servers. I've forced a sync and your current password should work on all devices now. The lock has been lifted.",
    ],
    "account_suspended": [
        "I've completed a manual review of your account and lifted the suspension. The automated system flagged several pins as potential spam due to a high posting volume over a short period, but after reviewing the content, they're all legitimate. I've added an override note to your account to prevent this from happening again.",
        "Your account suspension was triggered by our Guardian system detecting a pattern match with known spam behavior. I've reviewed your posting history and pin content — everything checks out as legitimate. The suspension has been reversed and your account is fully restored.",
        "I investigated your suspension and found it was a false positive from our automated enforcement. Your recent board activity matched a spam pattern signature, but the content itself is clearly original. I've reinstated your account and flagged the detection rule for review by our Trust & Safety team.",
    ],
    "account_recovery": [
        "I've verified your identity through the alternate email address on file and sent a recovery link to that address. The original email was deactivated on your provider's side, which is why the standard reset flow wasn't working. The recovery link expires in 24 hours.",
        "Your account recovery has been processed. I matched your identity using the phone number and account creation date you provided. A password reset link has been sent to the new email you specified. You should receive it within 10 minutes.",
        "I've completed the identity verification and restored access. The issue was that your email provider was bouncing our password reset emails due to a domain-level block. I've sent the reset link via SMS to the phone number on your account instead.",
        "After cross-referencing the details you provided with our records, I've confirmed your ownership and initiated the recovery process. I've updated the primary email to the one you specified and sent a secure reset link. Your boards and pins are all intact.",
        "I was able to verify your identity using the business account documentation you provided. The recovery link has been sent to your updated email. The issue was that your original email domain expired, which blocked all automated recovery flows. Everything is set for you to regain access.",
        "Your account recovery required a manual identity check since the phone number on file had been recycled. I've matched your identity using account creation metadata and pin history patterns. A secure recovery link has been sent to the email you provided in this ticket.",
        "I've processed your recovery request. The standard flow was blocked because your account had an active security hold from a previous suspicious login attempt. I've cleared the hold, verified your identity, and sent a password reset link. You should be all set within the next 10 minutes.",
    ],
    "login_issues": [
        "I investigated your login issue and found that your account was caught in a session migration during our recent platform update. I've cleared the stale session tokens on our end. Please try logging in again — you should be able to access your account normally now.",
        "The login failure was caused by a cookie conflict between the Pinterest app and the mobile browser session. I've reset your server-side session state. Please clear your browser cookies for pinterest.com and try again — that should resolve it.",
    ],
    "2fa_issues": [
        "I've disabled the two-factor authentication on your account so you can log in and reconfigure it. The issue was that the authenticator app's time sync drifted, causing code validation to fail. Once you're back in, I'd recommend re-enrolling 2FA from the security settings.",
        "Your 2FA backup codes had expired after the 90-day rotation policy. I've generated a new set of backup codes and sent them to your verified email. You can use any of those to log in, then re-enable your preferred 2FA method from settings.",
        "I've confirmed your identity and temporarily removed the 2FA requirement on your account. The TOTP codes were failing because the device clock was out of sync with our server. You can re-enable 2FA after logging in — make sure your phone's automatic time setting is turned on.",
        "The SMS-based 2FA was failing because the phone number on your account was outdated. I've verified your identity through the backup email and disabled 2FA so you can regain access. Please update your phone number and re-enable 2FA once you're logged in.",
    ],

    # ── content_moderation ──
    "pin_removed": [
        "I've reviewed the pin that was removed and confirmed it was flagged by our automated content detection system for a pattern match with prohibited material. After a manual review, the content is clearly educational and doesn't violate our guidelines. I've restored the pin and added an exemption flag.",
        "Your pin was caught by an updated content filter that was casting too wide a net on certain image categories. I've restored the pin after confirming it complies with our community guidelines. The filter rule has been reported to our content policy team for tuning.",
        "After reviewing the removed pin, I found it was flagged due to text overlay content that our OCR system misinterpreted. The pin has been restored to your board. Apologies for the inconvenience — I've submitted feedback on this false positive to improve our detection.",
    ],
    "board_removed": [
        "I've completed a review of your board and determined it was removed due to a bulk action that incorrectly swept it up when we took action on a cluster of policy-violating boards. Your board content is all compliant. I've restored the board with all its pins intact.",
        "Your board was flagged because several pins were detected as potential copyright violations by our automated scanner. After manual review, the pins are all original content or properly attributed. The board has been fully restored.",
        "I investigated and found the board removal was triggered by a report from another user. After reviewing all 47 pins on the board, none violate our community guidelines. I've reinstated the board and dismissed the report.",
    ],
    "false_positive_flag": [
        "I've reviewed your content and confirmed the flag was a false positive from our automated detection system. The image was incorrectly matched against a restricted content signature. I've removed the flag, restored full visibility, and submitted this case as a training example to improve our classifier.",
        "Your content was flagged by our Guardian system due to a visual similarity match that turned out to be incorrect. After manual review, your pin is clearly compliant. I've cleared the flag and your content distribution has been restored to normal.",
        "The false positive was caused by our text extraction system misreading a product label in your image. I've removed the flag and restored your pin. I've also escalated this detection pattern to our ML team so it gets corrected in the next model update.",
        "I reviewed the flagged content and confirmed it was incorrectly identified. The flag has been lifted and your pin is visible again. The automated system matched on background elements in the image — I've added this to our false positive training set.",
    ],
    "appeal_denied": [
        "I've conducted a second-level review of your appeal. The original denial was based on an incomplete review that didn't account for the full context of your pin. After a thorough reassessment, I've overturned the decision and restored your content with full distribution.",
        "I escalated your appeal to our senior content review team for a fresh assessment. They've determined that the original moderation action was overly broad. Your content has been reinstated and the appeal status updated to approved.",
        "After reviewing the appeal denial, I found the original reviewer applied the wrong policy section to your content. I've corrected the classification and restored your pin. The appeal has been marked as resolved in your favor.",
        "I've re-examined your case with our updated policy guidelines. The content in question falls within our acceptable use parameters. I've reversed the appeal denial and your pin is now live again with full reach.",
        "Your appeal was originally denied because the reviewer misidentified the product in your image as a restricted item. I've confirmed it's a standard consumer product and overturned the decision. Your content has been restored with full visibility.",
        "I reviewed the appeal chain and found the denial was based on an outdated policy interpretation that was revised last month. Under the current guidelines, your content is compliant. I've reversed the denial and restored your pin.",
        "After a thorough review with our senior moderation team, we've determined the original enforcement action was too aggressive for the content type. Your appeal has been approved and the content has been fully reinstated with no restrictions on distribution.",
    ],
    "ai_mislabel": [
        "I've reviewed the AI-generated content label on your pin and confirmed it was incorrectly applied. Your pin is clearly a photograph, not AI-generated content. I've removed the label and flagged this for our detection model's retraining pipeline. The correction should be visible within the hour.",
    ],
    "spam_flag": [
        "I reviewed your account and the spam flag was triggered because you saved a large number of pins in a short window, which our system interpreted as automated behavior. I've confirmed your activity is genuine and removed the spam designation. Your account reach has been restored.",
        "The spam flag on your account was a false positive from our behavioral detection system. Your pinning pattern matched a known bot signature, but after reviewing your content and session data, it's clear this is organic activity. I've cleared the flag and your pins are distributing normally again.",
        "Your pins were flagged as spam because they contained similar descriptions across multiple boards. Our system interpreted this as duplicate content distribution. I've reviewed the pins and they're all unique with legitimate descriptions. The spam flag has been removed.",
    ],

    # ── ads_billing ──
    "targeting_issues": [
        "I've reviewed your ad account and found that the targeting parameters on your active campaign were reset after the recent platform update on March 15. I've restored your saved audience segments and re-enabled interest-based targeting for your market. Your campaigns should reflect the correct targeting within 2 hours.",
        "The targeting issue was caused by a conflict between your location targeting settings and the new audience expansion feature that was enabled by default. I've disabled audience expansion and locked your targeting to your specified regions. Your ads should start delivering to the correct audience within the next refresh cycle.",
    ],
    "ad_rejected": [
        "I reviewed your rejected ad and the issue was that the landing page URL triggered our automated policy check because the page contains a countdown timer, which is flagged as urgency marketing. Since your timer is for a legitimate product launch event, I've approved the ad manually and added a policy exception note.",
        "Your ad was rejected because the ad copy contained a health-related claim that our system classified as requiring substantiation. I've reviewed the claim against your provided documentation and it meets our evidence threshold. The ad has been resubmitted for approval and should be live within 4 hours.",
        "The rejection was due to your image containing text that covers more than 20% of the image area, which violates our ad creative guidelines. However, after measuring it, the text coverage is actually at 18%. I've overridden the automated check and approved your ad.",
    ],
    "ad_review_delay": [
        "I see your ad has been in review for 72 hours, which is well outside our normal 24-hour window. I've escalated it to our ads review team with priority flagging. The delay was caused by a backlog in our manual review queue for ads in your product category. You should see a status update within 6 hours.",
        "Your ad was stuck in an extended review loop because the automated system couldn't classify your product category. I've manually assigned the correct category and pushed it back through the review pipeline. It should be approved and live within the next 2 hours.",
    ],
    "billing_dispute": [
        "I've reviewed your billing records and found the charge in question was from a campaign that was set to auto-renew. The renewal ran before you paused the campaign due to a timezone offset in the scheduling system. I've refunded the $47.50 charge and confirmed the campaign is now fully paused.",
    ],
    "ad_account_suspended": [
        "I've reviewed your ad account suspension and found it was triggered by a payment method flagged by our fraud detection system after a bank-issued card replacement. I've verified your identity and payment details, cleared the fraud flag, and reinstated your ad account. Your active campaigns will resume delivery within 1 hour.",
    ],
    "conversion_tracking": [
        "I investigated your conversion tracking issue and found that the Pinterest tag on your site is firing correctly, but the conversion events weren't being attributed because your attribution window was set to 1-day click instead of the 7-day default. I've updated the setting and your conversion data should start populating within 24 hours.",
        "The conversion tracking discrepancy was caused by a conflict between your tag manager setup and our updated pixel code. Your site is loading an older version of the Pinterest tag that doesn't support the new event schema. I've sent you the updated tag code — once you replace it, conversions will track accurately.",
        "After reviewing your tag installation and event logs, I found that conversions were being recorded but not attributed to the correct campaign due to a UTM parameter mismatch. I've corrected the campaign tracking settings on our end. Historical data can't be retroactively fixed, but going forward your attribution will be accurate.",
    ],

    # ── shopping_merchant ──
    "catalog_feed_error": [
        "I reviewed your catalog feed and found the ingestion error was caused by 23 products with missing GTIN fields, which our system requires for product matching. I've identified the specific items and sent you a CSV with the affected product IDs. Once you update those fields and resubmit, the feed should process within 2 hours.",
        "The feed error was triggered by a character encoding issue in your product descriptions — several entries contained non-UTF-8 characters that broke our parser. I've flagged the specific rows in your feed and sent the details to your email. After fixing the encoding, your next feed submission should process cleanly.",
    ],
    "product_pin_rejected": [
        "Your product pin was rejected because the price shown in the pin image didn't match the price in your data feed. Our system detected a $5 discrepancy caused by a currency conversion rounding error. I've corrected the feed entry and resubmitted the pin for approval. It should be live within 4 hours.",
    ],
    "merchant_verification": [
        "I've reviewed your merchant verification application and identified the issue — the domain verification step failed because the meta tag was placed in the body of your HTML rather than the head section. I've sent you the exact code snippet with placement instructions. Once you update it, resubmit the verification and it should be approved within 24 hours.",
    ],
    "rich_pin_issues": [
        "I investigated your rich pin issue and found that your Open Graph metadata is correctly formatted, but our crawler hasn't re-indexed your site since you updated the tags. I've triggered a manual re-crawl of your domain. Your rich pins should start showing the updated information within 12-24 hours.",
    ],

    # ── algorithm_reach ──
    "reach_drop": [
        "I looked into your reach drop and found it coincided with our March algorithm update that shifted distribution weight toward video and Idea pins. Your static pin performance is consistent with the platform-wide trend. I've flagged your account for the product team to review, and in the meantime I'd suggest experimenting with Idea pins to recover reach.",
    ],
    "deindexed_content": [
        "I checked your account and confirmed that 14 of your pins were deindexed due to a metadata formatting issue in your recent bulk upload. The image alt-text fields contained special characters that our indexer couldn't parse. I've resubmitted those pins for re-indexing and they should be searchable again within 48 hours.",
        "Your pins were deindexed after our automated quality check flagged them as potential thin content due to missing descriptions. I've reviewed them and they all have adequate context. I've overridden the quality flag and submitted them for re-indexing. They should reappear in search within 24-48 hours.",
        "The deindexing was caused by a domain-level penalty that was applied to your linked website after our crawlers detected a temporary 503 error. Your site is back up and I've removed the domain penalty. Your pins are being re-indexed now and should be fully restored within 48 hours.",
    ],
    "feed_quality": [
        "I looked into your feed quality concerns and can see that your content distribution shifted after the recent algorithm update. Your engagement metrics are actually stable — the reach change is affecting impression volume across the platform for your content category. I've flagged your account for a product team review and shared some format optimization tips via email.",
    ],
    "impressions_zero": [
        "I investigated your zero-impressions issue and found that your pins were caught in a distribution hold triggered by a bulk upload that our system flagged as potential spam. I've reviewed your content, cleared the hold, and your pins are now re-entering the distribution pipeline. You should start seeing impressions within 6-12 hours.",
        "The zero impressions on your recent pins were caused by a technical issue with our CDN not serving your pin images in certain regions. I've escalated this to our infrastructure team and they've resolved the caching issue. Your pins should start accumulating impressions normally now.",
    ],
    "analytics_broken": [
        "I checked your analytics dashboard and found the issue — the data pipeline for your account type experienced a delay during our March 18 system maintenance. Your analytics data is intact but showing a 48-hour gap. The backfill is in progress and should complete within 24 hours, at which point your historical data will be fully restored.",
    ],

    # ── spam_scam ──
    "bot_activity": [
        "I've reviewed the bot activity on your account and identified that the suspicious followers were part of a known bot network that we've been tracking. I've removed 342 bot followers from your account and applied a protective filter to prevent future bot follows. Your follower count now reflects genuine accounts only.",
    ],
    "phishing_link": [
        "I've investigated the phishing link you reported and confirmed it's a known malicious URL that was embedded in a pin comment. I've removed the comment, suspended the account that posted it, and flagged the domain across our platform. Thank you for reporting this — it helps us protect other users.",
    ],
    "scam_ads": [
        "Thank you for reporting the scam ad. I've verified that the advertiser account was using a stolen brand identity to promote fraudulent offers. The ad has been removed, the advertiser account has been permanently suspended, and we've blocked the associated payment method and domain from our platform.",
    ],

    # ── technical_bug ──
    "api_issues": [
        "I investigated your API issue and found that the 429 rate limit errors you're seeing are caused by a misconfigured retry loop in your integration that's hitting our endpoint faster than the documented 100 requests/minute limit. I've temporarily increased your rate limit to 200/min while you update your code, and I've sent documentation for proper exponential backoff implementation.",
        "The API authentication failures were caused by a token rotation that happened during our March 20 security update. Your existing OAuth tokens were invalidated. I've sent instructions to your developer email for generating new access tokens. Once refreshed, your integration should work normally.",
    ],
    "notification_issues": [
        "I looked into your notification issue and found that push notifications for your account were disabled on our server side after a batch process error last week. I've re-enabled them and triggered a test notification to verify delivery. You should have received it — please confirm, and if not we'll investigate the device-level settings.",
        "The missing notifications were caused by a sync issue between our notification service and your device token. Your device token had expired and our system wasn't sending the renewal request. I've forced a token refresh and your notifications should resume immediately.",
    ],
    "feature_not_working": [
        "I investigated the feature issue and found that the Idea pin creation tool is currently experiencing a known bug on Android 14 devices that prevents the multi-page editor from loading. Our engineering team deployed a fix yesterday and it should reach your app with the next auto-update. In the meantime, you can create Idea pins through the mobile web version at pinterest.com.",
    ],

    # ── privacy_legal ──
    "gdpr_request": [
        "I've initiated the GDPR Article 15 data access request for your account. Your data export is being compiled and will be delivered to your registered email address within 72 hours, well within the 30-day regulatory window. The export will include all personal data, pin history, ad interactions, and analytics data associated with your account.",
        "I've processed your GDPR Article 17 deletion request. All personal data including pins, boards, analytics history, and ad account data will be permanently removed within 30 days. You'll receive a confirmation email once the deletion is complete. Note that some data may be retained in encrypted backups for up to 90 days per our data retention policy.",
    ],
    "privacy_concern": [
        "I've reviewed the privacy concern you raised about your profile appearing in search engine results. I've enabled the 'Hide your profile from search engines' setting on your account, which sends a noindex directive to crawlers. It may take 2-4 weeks for existing cached results to be removed by the search engines, but no new indexing will occur.",
    ],
    "data_request": [
        "I've processed your data access request and your export package is being prepared. It will include your profile information, pin and board data, search history, ad interaction logs, and any device/session information associated with your account. You'll receive a secure download link at your registered email within 48 hours.",
    ],
}

# Fallback for any subcategory not in the bank
FALLBACK_RESPONSES = [
    "I've thoroughly reviewed your case and identified the specific issue. After investigating the underlying cause, I've applied the appropriate fix on our end and verified the resolution. The changes should be reflected on your account within the next few hours. Please let us know if you experience any further issues.",
    "I looked into this and found the root cause of the problem on our side. I've applied the necessary corrections to your account and confirmed everything is working as expected. The fix has been verified and you should see the update reflected shortly.",
    "After a detailed review of your account and the reported issue, I've identified what went wrong and applied a fix. I've also added a note to your account to prevent this from recurring. Please allow up to 24 hours for the changes to fully propagate.",
]


def patch():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    inpath = os.path.join(base, "integration-tickets", "integration_tickets.jsonl")
    outpath = inpath  # overwrite in place

    with open(inpath) as f:
        tickets = [json.loads(line) for line in f if line.strip()]

    # Track which variant index to use per subcategory to avoid repeats
    variant_counters = {}
    patched = 0
    hold_unchanged = 0

    for ticket in tickets:
        fm = ticket["_ground_truth"].get("failure_mode")
        if fm is not None:
            hold_unchanged += 1
            continue

        subcat = ticket["custom_fields_decoded"]["issue_subcategory"]
        pool = RESPONSE_BANK.get(subcat, FALLBACK_RESPONSES)

        idx = variant_counters.get(subcat, 0)
        response = pool[idx % len(pool)]
        variant_counters[subcat] = idx + 1

        ticket["agent_response_summary"] = response
        patched += 1

    # Write back
    with open(outpath, "w") as f:
        for ticket in tickets:
            f.write(json.dumps(ticket, ensure_ascii=False) + "\n")

    # ── Summary ──
    pass_responses = [
        t["agent_response_summary"]
        for t in tickets
        if t["_ground_truth"].get("failure_mode") is None
    ]
    lengths = [len(r) for r in pass_responses]
    has_placeholder = sum(1 for r in pass_responses if "{" in r)
    unique = len(set(pass_responses))
    total_pass = len(pass_responses)

    print(f"Patched: {patched} pass cases")
    print(f"Unchanged: {hold_unchanged} hold cases")
    print(f"Response lengths: min={min(lengths)}, max={max(lengths)}, median={statistics.median(lengths):.0f}, mean={statistics.mean(lengths):.0f}")
    print(f"Placeholders remaining: {has_placeholder}")
    print(f"Unique responses: {unique}/{total_pass}")

    if has_placeholder > 0:
        print("ERROR: Some responses still contain placeholders!")
    if unique < total_pass * 0.4:
        print("WARNING: High duplicate rate — consider adding more variants")


if __name__ == "__main__":
    patch()
