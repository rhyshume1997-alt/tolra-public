# G31 — Company AI budget

Version 1.0 draft | Decision supplied by Rhys, 5 November 2026 | Owner ____ | Approval/signature/date ____.

**Default: GBP 10 (1000p) per company per calendar month. Each company has its own settable cap. AI starts OFF.** Enabling it needs separate approval. This is not a shared GBP 10 allowance across all companies. The accounting month follows Europe/London in the reviewed SQL.

This decision supersedes #381's previous required-500p finding for release 146's Tolra-provided mode. That earlier run remains historical evidence of the old expectation; it is not a current defect merely because the default is 1000p. Do not erase the earlier evidence. The cap is a setting, not an immutable GBP 10 maximum: the approved administrator may change a company's allowance. Reducing it below already spent plus reserved usage refuses.

A reservation must refuse before reading a key or calling a provider when reserved + spent + this estimate exceeds that company's limit. Using or changing company A's budget must not affect company B's budget. Provider cost-estimation/billing accuracy is a separate assurance question.

The actual release-146 SQL name is `public.ai_helper_tolra_set_cap(uuid,integer,uuid)`, not a literal `tolra_set_cap` alias. It is a **platform-owner administrator operation through the service-role server path**. A company admin, office user or anonymous client cannot call it directly. The function checks the supplied owner's platform registry identity. The server's owner/MFA checks still need their own final-route proof; the database service role is trusted. Do not weaken these grants to give every company admin cross-company authority.

Scope: release 146 provided-mode cap. Legacy own-key `ai_helper_settings.monthly_cap_pence` has a separate 500p default from 122; this docs/tests PR does not silently change it or claim all modes have been aligned. If Rhys's new decision must cover that separate mode too, its implementation needs owner review.

Acceptance record: requirement G31; expected independent settable 1000p monthly default, off by default, cap stops provider calls, privileged setter only; actual ____ NOT EXECUTED for final release acceptance; evidence ____; tester ____; date ____; approval ____.
