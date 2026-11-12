# C04 — validation summary report for Rhys

**DRAFT — NOT VALIDATED / NOT APPROVED.** This form has no completed test results or signatures. It explains what was checked, what went wrong and whether the agreed use is safe. Rhys fills the decision after seeing the real evidence; Code supplies technical reports; John accepts the working process; an independent reviewer records their view. No automated log signs for them.

## 1. Which system and use does this cover?

| Fill this in | Human entry |
| --- | --- |
| Company / intended daily work | ____ |
| Exact app commit, release/build and any differences | ____ |
| Actual test address, backend identity and test dates | ____ |
| Intended opening target / separately agreed scope | ____ |
| Prepared by / date | ____ |
| Rhys, validation lead / John, process owner / Code / independent reviewer | ____ / ____ / ____ / ____ |
| Approved requirements (URS), risk assessment and traceability revisions | ____ / ____ / ____ |
| Approved IQ/OQ/PQ and manual-check revisions | ____ |
| Private Operations Pack revision; every item mapped to a check | ____ |
| Private evidence index, manifests/hashes, commands/tool versions and exit codes | ____ |

Write the full version, not just “latest”. Keep old evidence attached to the old version. If code, settings, mapping or process changed after testing, list affected checks and actual retests: ____.

## 2. What was actually proved?

IQ means the test installation was identified and ready. OQ means the controls worked. PQ means John could complete the agreed working process. A source table, mapped test, collected browser case, mock provider or skipped test is not proof that the real required check passed.

| Check group | Reference count only | Approved planned count | Passed | Failed | Not run | Scope exclusions, exact IDs and signed reason | Actual dated evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IQ: test installation | Refreshed pack: 6 | ____ | ____ | ____ | ____ | ____ | ____ |
| OQ: working controls | Refreshed pack: 14 | ____ | ____ | ____ | ____ | ____ | ____ |
| PQ: John’s work | Refreshed pack: 8 | ____ | ____ | ____ | ____ | ____ | ____ |
| C03 human checks / source G, DAY, UAT, CW and named decisions | Use approved C03 scope | ____ | ____ | ____ | ____ | ____ | ____ |
| Actual DB/browser/provider, cap race, penny parity and release/rollback proofs | Per approved proof list | ____ | ____ | ____ | ____ | ____ | ____ |

Counts must reconcile to the approved row IDs; do not count a skipped/not-run row as passed. The older pack has 15 OQ/9 PQ, and manual versions have 35/60/64 rows. Rhys/Code must record the actual agreed revision and any differences: ____. Keep required transfer/backup/wipe/preservation proof even if the refreshed PQ table has eight rows; do not discard it through a smaller count.

| Human review of a required subject | Actual result and report — leave blank until checked |
| --- | --- |
| Correct company/role, secrets and support boundaries | ____ |
| Exact money, draft/payment separation, paid claims and rounding parity | ____ |
| Hours/breaks, job work, print/drawing and audit | ____ |
| Exact approved chase text, double/stale refusal and uncertain-send hold | ____ |
| Both AI modes, key isolation, owner MFA, caps and real independent-session race | ____ |
| Xero supported export / separate Sage-QBO balance checks; encrypted tokens and provider/company isolation | ____ |
| Blank company setup and both email editors/legacy text | ____ |
| Real restore, protected other-company records, exact 18-CW kit proof and approved transfer reconciliation | ____ |
| John device/workday practice, staff/paper fallback, contacts and primary/cover admin codes | ____ |
| Fresh opening checkpoint, ordered six-release verification and approved smoke checks | ____ |

## 3. Problems, changes and missing checks

Copy every failed, missing, skipped or changed-version item here, including gaps from the source validation pack. A missing private report stays missing. Use more rows if needed.

| Deviation ID | Requirement/check IDs; what actually happened | Impact / who is affected | Fix or proposed limit | Owner / due date | Same-version retest and independent review | Open / closed, by whom/date |
| --- | --- | --- | --- | --- | --- | --- |
| ____ | ____ | ____ | ____ | ____ | ____ | ____ |
| ____ | ____ | ____ | ____ | ____ | ____ | ____ |

**Failed high-risk checks and unmet pre-use controls block the affected release/use until fixed and retested.** A signature cannot turn Not run into Pass. A successful safe refusal does not prove a successful provider connection or real mailbox receipt. Record anything excluded from use and prove the control keeps it off.

## 4. Limits and remaining risks

Carry the older transfer risk RISK-015/URS-015 forward explicitly where that scope applies; C05 adds a scope-qualified row. Refreshed RISK-001–014 does not erase it. Counts satisfy Passed + Failed + Not run = approved planned count; scope-excluded IDs are listed separately and never counted as Pass. No row may disappear from both the count and deviation list.


Use `C05-P6-OPEN-RISKS.md` and the eight-limit sheet (L4/#347). R1–R8 are proposals until Rhys decides individually; the source word “Accepted.” never signs for him. Keep the requirement risks RISK-001–014 and new P6 risks separate from those eight limit IDs.

| Item / exact agreed wording or register row | Supporting proof / what is NOT proved | Mitigation, owner and review date | Rhys accepts / does not accept; reason and signature/date |
| --- | --- | --- | --- |
| R1 — live accounting behaviour | ____ | ____ | ____ |
| R2 — provider rehearsal/setup gaps | ____ | ____ | ____ |
| R3 — no 146 reinstall after rollback | ____ | ____ | ____ |
| R4 — separate exact wipe-kit authority/proof | ____ | ____ | ____ |
| R5 — real mail delivery limits | ____ | ____ | ____ |
| R6 — AI billing/latency and control limits | ____ | ____ | ____ |
| R7 — actual version/environment and hosted/load limits | ____ | ____ | ____ |
| R8 — explicit deferred-feature/manual-ID scope | ____ | ____ | ____ |
| Other open requirement / P6 risks and deviations (attach every row) | ____ | ____ | ____ |

Never promise Sage/QBO invoice exports, reset existing AI usage/caps, use cap exhaustion as AI-off, or reinstall 146 after rollback. Releases 142/143 are outside the declared six-release set; ordinary timesheet/email/editor and supported provider-balance checks are not automatically excluded. The private wipe kit needs its own proof/approval. No restriction waives those prerequisites.

## 5. Rhys's validation decision — HUMAN ONLY

Code — technical evidence completeness, exact app/pack/target and unresolved gaps: name ____ signature ____ date ____ evidence revision ____.

Accountant — WIP cost and source/target financial/aged-debtors tie-out: name ____ signature ____ date ____ report ____. If not complete, record a blocker; a proposed accountant role is not approval.

Delivery-note required-use UAT and John acceptance attachment: ____; open gaps/retests ____ (do not infer from general document printing).


Tick exactly one after reviewing every required item:

- [ ] NOT APPROVED — required proof or control is missing/failed
- [ ] APPROVED WITH RECORDED LIMITS — all mandatory pre-use controls pass; exact permitted use and accepted residual limits are attached
- [ ] APPROVED — agreed requirements have the required evidence and no unmet pre-use condition remains

Reason, actual proof and remaining risk: ____

Permitted company/version/features/use; disabled features; conditions to satisfy BEFORE use: ____

Rhys — name ____ signature ____ date/time ____

Independent reviewer — verdict ____ name ____ signature ____ date/time ____

John — process acceptance / exceptions ____ name ____ signature ____ date/time ____

A VSR decision is separate from operational opening authority. Controlled smoke-check access is a separate limited authority, not routine opening GO. Record the separate final operational GO/STOP only after the required C16 smoke results and final gate; C16 completion reference: ____. No merge, production SQL, wipe, import or deployment is authorised by creating this draft. Reassess affected requirements after a change; keep signed old versions and evidence. This supports the company's quality process and does not certify JNR to ISO 9001.

## Sources and L7 handover

Based on `tests/validation/VSR-TEMPLATE.md`, IQ/OQ/PQ and risk/traceability files at `claude/258-refresh` `cd3ca6eebe787e6fe65483e70a274b446af9a033`, with #322's qualified restrictions, #299/#300's evidence/count reconciliation, corrected #314/#305 process sheets and L4/#347. C03/C05/C16 companion filenames refer to this review queue; each is a separate draft.

Builder 6 / atomic claims/L7, 4 November 2026. Checked source sections/count distinctions, no invented results/decisions/signatures, complete risk/deviation/evidence fields and whitespace. Documentation only; actual validation and human signatures remain open. No new app scope, main merge, production SQL, deployment or Ready label. Rhys/Code/reviewer supply final-version evidence and decide next.
