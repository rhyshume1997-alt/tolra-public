# G07 — Candidate change and impact record

Version 0.1 draft | Prepared 4 November 2026 | Owner ____ | Approved issue/effective date ____.

**NOT EXECUTED.** Blank fields are not results or consent. Complete records privately after the work; no real data belongs in this public template. Tolra supports JNR’s quality work; JNR is audited, and these documents cannot certify it.

## Identify exactly what changes

Requirement ID: G07-CHANGE-____. From candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`; to delivery-notes candidate full SHA ____; date proposed ____; proposer ____; release/app package hashes ____; installed database state ____.

The following are **scope to verify**, not confirmation that they are present or accepted:

| Change to assess | Exact file/package/version and effect |
| --- | --- |
| Release 147 (release number, not PR #147) | ____ |
| Day-of delivery-note (DLN) counter setup/continuity | ____ |
| Job/customer/order matching fixes | ____ |
| Save/retry/replay fixes preventing duplicate notes or effects | ____ |

Affected people/processes/records ____; permissions/company isolation impact ____; invoice/payment/counter impact ____; printing/signature/email impact ____; training/document updates ____; recovery/compatibility impact ____; risks and owner ____.

## Decide evidence reuse before accepting the change

Evidence proposed for reuse ____; original artifact/run/check IDs and SHA ____; exact reason its relevant inputs/code/environment are unchanged ____; independent reviewer decision ____.

Checks to re-run on the **new exact SHA** ____; include delivery with/without an order, numbering/day boundary/concurrency, matching/company boundaries, repeat/lost-save replay, permission/refusal cases, inspection/release controls, print/PDF/signatures and invoice/payment invariance where affected. Add any regression triggered by the actual diff. Existing green evidence alone cannot waive changed behaviour.

## Assessment/execution record — copy for each requirement or regression

Requirement ID: G07-CHECK-____; expected result ____; actual result ____ — **NOT EXECUTED**; evidence reference (run/artifact/log hash, exact SHA) ____; tester ____; date ____; approval ____.

Regression summary ____ — **NOT EXECUTED**; deviations/restrictions ____; remaining risk/owner ____; go/hold decision ____; approval name/signature/date ____.

No exact new SHA is supplied by this template. Code must identify the reviewed combined candidate and actual release 147 package; Rhys must approve the change through the existing release process. Do not execute SQL or reset a counter from this sheet. If 146 has been rolled back, never re-apply it; use the approved recovery route.

Builder 5: document-only template. No test, load, restore, production SQL, merge or message to John performed. Source/whitespace review only; operational results and approvals remain NOT EXECUTED/blank.
