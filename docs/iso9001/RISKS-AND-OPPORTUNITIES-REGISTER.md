# Risks and opportunities — working register (6.1)

Document ID: JNR-I5-RISKS-AND-OPPORTUNITIES-REGISTER | Version: 0.1 draft | Prepared: 4 November 2026

Proposed owner: John (JNR), with Rhys for Tolra technical facts. Owner appointment, approval, effective date and next review: ____ .

Tolra supports JNR Engineering’s quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015.

## How John uses this sheet

This is a pre-filled starting list, not a completed risk assessment. John names real owners, rates likelihood, checks controls and accepts or rejects remaining risk with dates. Rhys/operator supplies technical proof. Leave “not checked” where proof is missing. Review before cutover, after a serious change/incident and at the agreed review date. Include the whole shop, not only Tolra.

Source: [tests/validation/RISK-ASSESSMENT.md](https://github.com/rhyshume1997-alt/tolra-public/blob/e71a80072148077a4c0f05184fe40d79688c01ee/tests/validation/RISK-ASSESSMENT.md) (#276/CE), RISK-001–015. The later diagnostic refresh at [tests/validation/RISK-ASSESSMENT.md](https://github.com/rhyshume1997-alt/tolra-public/blob/f76a5b84da1f01626cc81d17150e08e6069ef794/tests/validation/RISK-ASSESSMENT.md) has RISK-001–014 only. Do not silently drop RISK-015: CE adds its cutover evidence risk. This sheet preserves it as a CE source row. These unmerged source versions are not the installed release or signed validation results. Use the final agreed validation pack before release.

The source calls wrong money, disclosure, permissions or untraceable change **High**, and says a failed high-risk check blocks release. It rates wrong paperwork **Medium**. Those are copied impact labels, not new accepted risk ratings. No likelihood or residual score has been invented. John should assess how a drawing error could affect actual CNC/fabrication safety and conformity.

Suggested rating method for John to approve: likelihood 1 unlikely / 2 possible / 3 likely; impact 1 small / 2 significant / 3 serious. Record the reason, not just the product. Set escalation/acceptance rules before scoring; never use a low score to bypass a required release check.

Register owner ____; scope/processes ____; method/thresholds approved by/date ____; next review ____.

| ID / source | What could go wrong / effect | Source impact | Existing/proposed control and proof to obtain | Proposed accountable role (appoint name) | Status |
| --- | --- | --- | --- | --- | --- |
| RISK-001 / URS-001 | Another company sees JNR’s private records | High | OQ-001; G01.4/G08.2/G08.5; prove two-company isolation on exact release. | Rhys + operator | Not checked here |
| RISK-002 / URS-002 | Staff approve or administer without authority | High | OQ-002; G07.2/G07.4/G08.5; prove role refusals; John reviews the real access list. | John + Rhys | Not checked here |
| RISK-003 / URS-003 | Invoice/credit totals are wrong | High | OQ-003; G01.2/G01.3/G13.1; reconcile exact pence and expected rounding. | John + accountant | Not checked here |
| RISK-004 / URS-004 | Draft edits change money owed | High | OQ-004; G01.2/G01.3/G13.1; prove issued/draft boundaries and before/after totals. | Rhys + operator | Not checked here |
| RISK-005 / URS-005 | Work restarts without a trace | High | OQ-005; G13.2; check reopen/rework reason, person and history. | Workshop lead | Not checked here |
| RISK-006 / URS-006 | Paid hours are wrong | High | OQ-006; G04.1–G04.3; John checks real breaks/rounding and week approval against agreed rules. | John + payroll lead | Not checked here |
| RISK-007 / URS-007 | Wrong drawing/paperwork reaches the floor | Medium | OQ-007; G13.3; compare job/drawing revision and remove old shop copies. | Workshop lead | Not checked here |
| RISK-008 / URS-008 | JNR cannot explain a change | High | OQ-008; G13.4; inspect actor/time/reason and relevant event history. | Rhys + records lead | Not checked here |
| RISK-009 / URS-009 | Tokens leak, provider/company records mix, or accounting exports duplicate | High | OQ-009; G06.1–G06.4/G09.1–G09.4; prove provider isolation and retry behaviour; protect tokens. | Rhys + operator | Not checked here |
| RISK-010 / URS-010 | AI key leaks, cap changes are unauthorised or spending runs away | High | OQ-010; G05.1–G05.5/G12.1–G12.4; prove both modes/access/caps and obtain existing data-sharing decision. | Rhys + John | Not checked here |
| RISK-011 / URS-011 | Setup shows another company or allows unauthorised progress | High | OQ-011; G08.1–G08.5; check a blank company and authorised setup access. | Rhys + operator | Not checked here |
| RISK-012 / URS-012 | Editing a template changes old text or allows unauthorised edits | High | OQ-012; G10.1–G10.4; compare both editors, permissions and legacy output. | Office lead + Rhys | Not checked here |
| RISK-013 / URS-013 | Wrong, unapproved or duplicate message is sent | High | OQ-013; G02.1–G02.6/G11.1–G11.2; prove reviewed text/customer/retry; hold unknown sends. | Office lead + Rhys | Not checked here |
| RISK-014 / URS-014 | An email wrongly clears a real debt | High | OQ-014; G03.1–G03.4; prove inbound mail does not change real financial balances. | John + Rhys | Not checked here |
| RISK-015 / URS-015 (CE only) | Wrong data or incomplete proof is accepted at cutover | High | OQ-015; G15.1–G15.4; refuse missing evidence, reconcile exact pence and review independent results. | John + Rhys + operator | Not checked here |
| CUT-01 / D6 draft #293 | Backup cannot restore records and drawings, or a restore loses later work | Proposed High; John confirms | Prove isolated restore, files/fingerprints and chosen recovery point; agree maximum downtime/data loss and reconcile later work. | Rhys + operator + John | Not checked here |
| CUT-02 / D6 draft #293 | 146 is reinstalled after rollback and retained history is damaged | Proposed High; John confirms | STOP: never reinstall 146 after rollback or erase retained history to bypass it. Recover a compatible installed state only from a verified matching backup under the approved runbook. | Rhys + operator | Not checked here |
| CUT-03 / F5 draft #292 | Paper or queued work is lost or entered twice during an outage | Proposed High; John confirms | Number paper sheets, hold unknown saves/sends, reconcile against queued/saved entries once with a second checker before normal entry resumes. | Office + workshop leads | Not checked here |
| SHOP-01 / JNR assessment needed | A bad/overdue gauge accepts wrong parts | John to rate | Identify gauges, prove calibration/verification and assess earlier parts if a gauge fails. | John + inspection lead | Not checked here |
| SHOP-02 / JNR assessment needed | Bad material, subcontract process or mixed batches reach a customer | John to rate | Evaluate suppliers, check certs/receipts, preserve physical batch identity and inspect/release correctly. | John + purchasing/workshop leads | Not checked here |

CUT rows are added from builder 4’s separate runbooks, not presented as validation-pack risk IDs. Shop rows are prompts, not an exhaustive CNC/fabrication risk assessment. Consider capacity, welding qualification, machine failure, customer changes and climate-related supply disruption where relevant.

## Complete one action/review row for each ID above

Copy this row for every risk. Keep previous decisions when ratings change.

| Risk ID | Likelihood/impact before and reason | Action/resources | Named owner | Due | Actual proof/result/date | Likelihood/impact after and reason | Remaining risk decision and approver/date | Next review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ____ | ____ | ____ | ____ | ____ | ____ | ____ | ____ | ____ |

## Opportunities — proposals, not promised gains

| ID | Opportunity and intended benefit | Proposed action/owner | Measure of success | Due / actual result / decision |
| --- | --- | --- | --- | --- |
| OPP-01 | Fewer mixed-up jobs through linked quote/order/job records | John: trial one end-to-end trace and teach the method | Agreed sample finds the correct drawing/material/release without unexplained gaps | ____ / ____ / ____ |
| OPP-02 | Less repeated entry after outages | Office lead: rehearse numbered paper/queue reconciliation | No missing or duplicate entries in the agreed rehearsal sample | ____ / ____ / ____ |
| OPP-03 | Learn from defects and supplier issues | Quality lead: review the external action log with job links | John chooses a baseline and repeat-defect measure | ____ / ____ / ____ |
| OPP-04 | Faster access to correct instructions | Records lead: controlled master and checked shop copies | Staff retrieve the right revision in an observed task | ____ / ____ / ____ |
| ____ | ____ | ____ | ____ | ____ |

Related source drafts: [tests/D6-CUTOVER-ROLLBACK-RUNBOOK.md](https://github.com/rhyshume1997-alt/tolra-public/blob/0cfe4495a805d0c41acbdbe7a5f8b892006df68a/tests/D6-CUTOVER-ROLLBACK-RUNBOOK.md); [docs/F5-WORKSHOP-PAPER-FALLBACK.md](https://github.com/rhyshume1997-alt/tolra-public/blob/55ee54c3b64d812745731a7090c42b483571f7c0/docs/F5-WORKSHOP-PAPER-FALLBACK.md). No SQL, restore, cutover, risk acceptance or validation was performed for this sheet.
