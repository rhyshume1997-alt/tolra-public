# Restrictions and assumptions

**Software status: NOT VALIDATED.** Nothing in this file is accepted yet. R1 to R8 are proposed wordings for the VSR "accepted restriction" section. Rhys accepts, edits or rejects each one and initials it himself; every acceptance line below is blank. Code does not accept restrictions on his behalf.

Release order for go-live, as declared in `manifest.json`: backup, preflight, then releases **138, 140, 141, 144, 145, 146**, each with its verify file, then a first-day smoke check.

## Proposed limits — unproved pre-use checks still block affected use

| ID | Proposed wording | Accepted / edited / rejected by Rhys, initials, date |
| --- | --- | --- |
| R1 | Xero export and Xero/Sage/QuickBooks balance-check paths have code and synthetic tests. Sage/QuickBooks do not export invoices in this release. Record the exact completed synthetic/sandbox reports separately; this proposal claims no completed provider validation. Live rate limits, expiry and provider changes need supervised checks. Only approved Xero exports may be sent, one reviewed invoice at a time; a balance result never records payment by itself. | ____ |
| R2 | For each provider, record whether registration, a successful connection and the supported sandbox action actually passed, and name the dated report. Unknown registration is not proof that none exists. Missing rehearsal stays NOT RUN and the affected provider stays off until separately approved supervised setup/use. Xero export checks and Sage/QuickBooks balance checks have different scope. Refusal/encrypted-storage test definitions alone do not prove a completed rehearsal. | ____ |
| R3 | Release 146 cannot be re-applied after rollback. Usage, request history and key_source remain; rollback refuses outstanding Tolra reservations. STOP and preserve evidence. Live recovery needs a separately reviewed verified backup containing the required state, compatible app and reconciliation of later work; an older backup cannot manufacture that state. A fresh test rehearsal requires an authorised disposable reset/restore to reviewed baseline, then the reviewed order. Never reset real data, delete retained history or weaken guards to force reinstall. No acceptance is pre-filled. | ____ |
| R4 | The private combined wipe kit is outside this software validation scope. Its exact rehearsal/review result is not established by this file. No production use until the exact kit has its own passing disposable-restore rehearsal, all preservation/archive/refusal checks, independent review and separate authority. A temporary source twin or unit mock is insufficient. Missing evidence blocks clearing/import; a scope restriction cannot waive it. | ____ |
| R5 | Controlled catcher/mock and real SQL/browser chase tests exist; name actual passing same-version reports before calling them proved. Their definitions do not establish real mailbox receipt or deliverability. First approved live use is supervised, one exact reviewed message at a time. Uncertain delivery stays held with no blind resend or ordinary-draft bypass. Receipt is separate from provider acceptance and never marks an invoice paid. | ____ |
| R6 | Cap/key/isolation and two-session reservation tests exist; attach their actual results before calling them proved. Synthetic keys/mocks do not prove real billing or latency. New/unconfigured company caps default to 1000p (£10), maximum 100000p (£1,000); existing saved caps/usage must not be reset. API changes require a registered platform owner with MFA; the SQL writer is service-only and checks the supplied owner registry identity. Rhys is the intended operator, not a hard-coded sole identity. A cap equal to used+reserved is not an off switch; settlement can release headroom. Use the company AI-off controls. | ____ |
| R7 | Record each actual tested version, target, dated command result and environment. This proposal does not assert completed local or hosted validation. Disposable results do not prove hosted Supabase/Vercel behaviour, JNR volume or a full working period. Required release order is backup, preflight, 138, 140, 141, 144, 145, 146, each verified, followed by the approved transfer/opening checks and Rhys's smoke check. A changed version needs affected checks repeated; no first-day sheet waives missing pre-use evidence. | ____ |
| R8 | The declared release plan excludes 142 (optional weekday email scheduling) and 143 (costing rates/atomic costing proposal). That does not remove existing timesheet-email/editor features or accounting balance checks. The separate bank-reconciliation workflow is not identified as an included feature; bank-details fields and payment comparisons are not that workflow. Identify each excluded manual ID in tests/MANUAL-CHECKS-GO-LIVE.md and obtain an explicit scope decision; keep unrun rows visible, never auto-mark N/A or Pass. No accepted exclusion is filled here. | ____ |

## Assumptions

### A1. Money rounding rule (decision by Rhys, 4 Nov 2026)

"Money always rounds to the nearest penny, with halves going up (0.135 becomes 0.14). The app and the database both do this, exactly as they do today. No change."

In technical words: round half away from zero to 2 decimal places, the intended convention in the app (`lib/money.ts`) and database (Postgres `round(numeric, 2)`). Agreement still requires the actual parity result. Consequences for this pack:

- URS-003 means "exact pence, half away from zero". It does not mean bankers' (half-to-even) rounding. OQ-003 compares saved and printed totals against this rule.
- The refresh reports a private 38-tie reconciliation, including 21 half-even differences. That private artifact is not visible here and is not an IQ/OQ result. The app cases and real PostgreSQL parity test on #284 define additional checks; this review did not run SQL parity.
- The protected deferred costing engine deliberately uses half-to-even. An optional non-costing reconciliation helper also exposes half-even, so the word “only” is not justified. Do not use that helper for financial cutover values. The release-143 costing exception matches the original engine; its 60 golden answers are untouched. A reconciliation helper that uses half-to-even must not be used for money.
- The source revision and rounding evidence must be pinned separately. A no-diff CI line does not prove the app and PostgreSQL agree or fill the VSR.

### A2. Other assumptions

- The test environment is a disposable copy with fake data. No production system, real customer record, real key or secret is used by any step here.
- The pack executes only mapped unit files itself. Database, browser and manual rows are performed on the disposable backend by the named person and recorded in the results file.
- Rhys alone signs the VSR. The process owner (John) performs PQ. No result, decision or signature is pre-filled.

## Review provenance

Corrected by CZ from the documentation-only f76a5b84 refresh, checked against its declared 9c3f5c6 application and the later builder3 source/evidence. This copies no diagnostic application code and changes no protocol count, application, SQL, fixture or acceptance. See [CZ source review](../../docs/handover/R1-R8-CODE-CHECK.md) for every occurrence, exact source lines and visibility limits.
