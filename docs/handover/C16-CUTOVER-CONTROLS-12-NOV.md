# C16 — Thursday 12 November 2026 cutover controls

Draft / Builder 6 L9. **Rhys decides GO/STOP; Code ticks technical steps; John checks source/work records; reviewer checks independent proof.** Code means the separately authorised operator. This is an unexecuted controls sheet, not permission to merge, deploy, run production SQL, clear or import data. All actions first need their existing reviewed procedure and separate authority. No live commands are included here.

| Before starting — fill privately | Actual entry |
| --- | --- |
| Date/window/time zone; final GO deadline and cut-off | Thu 12 Nov 2026 / ____ / Europe/London (GMT) / ____ |
| Frozen app commit/build; release-plan/kit/mapping versions and hashes | ____ |
| Intended target/JNR identity; protected Marpet identity (private references) | ____ / ____ |
| Named Code, deputy, John, Rhys, reviewer, accountant, recovery contact | ____ |
| Complete Operations Pack; C03/C04/C05 revisions; evidence folder | ____ |
| Exact rehearsal verdict and separate live-operation authority | ____ |
| Source cut-off/export manifest; writer stop/resume owners and boundaries | ____ |
| Fresh verified recovery checkpoint and reviewed later-work/other-company impact | ____ |

Build/tests finish Friday 6 November. A later code/config/mapping change needs affected checks repeated, not renamed old reports. Monday preparation approval is not Thursday GO. Saturday clearing is not permission to clear again on Thursday; independently establish actual state before taking any action. Use the same agreed code/files and actual target identity throughout.

Each GO tick permits **the next numbered row only**. Tick exactly one, record actual result/time and attach complete private evidence. Missing/false/NULL/empty required check, dirty/wrong version, ambiguous target, active unapproved writer, held/unresolved row, uncertain commit/send or unmet authority means STOP. Keep writers fenced as agreed, save evidence and tell Rhys; do not blindly repeat a write.

## Before release steps

| Step / pass condition | Who ticks | Stop point | Result / time / actual result / evidence |
| --- | --- | --- | --- |
| C16-01 Confirm frozen version, exact target, complete private pack, approved scope, independent verdict and any live authority. All required high-risk/pre-use C03/C05 controls have passing evidence. | Rhys + reviewer; Code identifies target | Missing pack/review/authority, changed head or open blocking proof: do not start. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-02 John closes SliQ at the agreed cut-off and supplies fresh full exports. Code verifies actual header mapping, stable IDs, all sixteen report types, filters, hashes, text identifiers/zeros, pence and next numbers. Accountant confirms WIP COST. | John + Code; accountant WIP | Missing/ambiguous file/row, only fake report, guessed zero, unsupported data route or unexplained money/WIP: no transfer. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-03 Stop only agreed source/target writers and hold their boundaries: app edits, mail/chase, accounting/polling and import; protect Marpet services/settings. Retain full before-state records and agreed paper fallback. | Code; John confirms source freeze | Any uncontrolled writer, scope drift or missing owner/baseline: no change. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-04 Identify the fresh approved backup/checkpoint; prove it restores into a separate empty disposable target, with complete records/money, stored-file BYTES, security/access/settings and required recovery state compared. Record elapsed restore/check time. | Code + reviewer; Rhys checks proof | Dump-only/count/sample proof, stale Friday copy, missing file/state or recovery target unclear: no release. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-05 Review exact release inventory/hashes, prerequisites through 137 and applied markers; perform approved read-only preflight on the intended target. Explain only the expected not-yet-installed markers. | Code + reviewer | Unexpected object/grant/hash/marker, empty result or wrong state: no 138. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |

## Mandatory order: 138 → 140 → 141 → 144 → 145 → 146

For each row use the **complete reviewed release transaction** under separate authority, then its complete verification. Save release/check file hashes, full output, exit codes, target/time/commit and every expected check name/result. Do not paste inner statements. An already-installed release advances only after verifying the exact reviewed state; never reinstall blindly. 140/141 are required for JNR. 142/143 are outside this cutover and must not be inserted. The separate chase-settings/atomic proposal must have an explicit reviewed disposition; a browser fixture is not production packaging.

| Step / release and verification | Who ticks | GO only when / STOP before next release | Result / time / actual result / evidence |
| --- | --- | --- | --- |
| **C16-06 / 138** `supabase/release/138_chase_steps.release.sql`<br>Verify: `supabase/verify/chase_steps_138.sql` | Code; reviewer checks evidence | Chase structures, functions, permissions and expected marker agree. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| **C16-07 / 140** `supabase/release/140_import_source_ref.release.sql`<br>Verify: `supabase/verify/import_source_ref_140.sql` | Code; reviewer checks evidence | Source references/company links and all expected checks agree. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| **C16-08 / 141** `supabase/release/141_opening_wip.release.sql`<br>Verify: `supabase/verify/opening_wip_141.sql` | Code; reviewer checks evidence | Opening WIP structure, company isolation, permissions and expected marker agree. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| **C16-09 / 144** `supabase/release/144_accounting_connections.release.sql`<br>Verify: `supabase/verify/accounting_connections_144.sql` | Code; reviewer checks evidence | Accounting structures, company/provider isolation, grants and marker agree. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| **C16-10 / 145** `supabase/release/145_company_setup.release.sql`<br>Verify: `supabase/verify/company_setup_145.sql` | Code; reviewer checks evidence | Own-company non-support admin setup permissions and expected marker agree; private helpers remain private. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| **C16-11 / 146** `supabase/release/146_tolra_provided_ai.release.sql`<br>Verify: `supabase/verify/tolra_provided_ai_146.sql` | Code; reviewer checks evidence | AI key/mode/cap permissions and marker agree; default applies only where appropriate, saved caps/usage remain; no prior rollback/reinstall or outstanding-guard bypass. Any required missing/false/NULL/empty check or failed transaction: STOP; do not start the next step. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |

| Step / pass condition | Who ticks | Stop point | Result / time / actual result / evidence |
| --- | --- | --- | --- |
| C16-12 Full combined read-only `supabase/verify/release_preflight.sql` and actual ordered upgrade evidence match the six releases and same final target/version. | Code + reviewer | A fixture's historical baseline order, missing marker or incomplete/false output is insufficient; no transfer/use. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |

## Transfer and preservation gates

| Step / pass condition | Who ticks | Stop point | Result / time / actual result / evidence |
| --- | --- | --- | --- |
| C16-13 Identify actual Saturday/current clearing state, exact private kit, all 18 passing real-driver CW proofs on disposable restore and independent verdict. Verify JNR-only Xero/Sage/QBO disconnection and protected Marpet/Microsoft/settings/numbering/security/audit/file boundaries. | Code + reviewer; Rhys authority | Unknown clearing/connected provider, missing proof/kit/authority or protected difference: no clearing or dependent import; no repeat wipe by calendar. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-14 If further clearing is specifically authorised, prove locked append-only archive equality/access and full invoice/send/message evidence BEFORE any approved JNR-only delete, within the reviewed atomic driver; preserve all KEEP rows. If already cleared, verify accepted historical/current proof rather than rerun deletion. | Code + reviewer; John scope | Missing archive/text/recipient/actor/time/digest, role access, disabled guard/FK, active writer or protected drift: refuse whole operation. An inapplicable write is not done just to tick. | [ ] GO [ ] STOP · time ____ actual/state ____ file ____ initials ____ |
| C16-15 Read the real existing importer's no-write report against John's frozen files and confirmed mapping. Account for every error/hold/duplicate/ambiguous row and approved scope route. Fixed fake wrapper output is supporting evidence only. | John + Code + reviewer | Unconfirmed mapping, lost zeros, missing report, comparison-only data assumed written or unexplained row: no load. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-16 Record explicit authority for the exact target/files/route, then authorised Code performs the reviewed load once, with full actual result/accounting of source rows. | Rhys authorises; Code executes; John checks scope | Missing authority or partial/uncertain result: hold; determine actual saved state before any retry. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-17 Independently compare complete source/target identities, balances/pence, payments/credits/refunds, orders/jobs/deliveries and WIP cost; verify next numbers above imported IDs and every protected record/file/access/setting/audit unchanged as required. | John + accountant + Code; reviewer | INCOMPLETE/UNVERIFIED/held/missing/unexplained difference, sale-price WIP or collision: no opening. Do not re-round imported money or reset counters. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |

## Final decision, opening and stop controls

| Step / pass condition | Who ticks | Stop point | Result / time / actual result / evidence |
| --- | --- | --- | --- |
| C16-18 Same-final-version disposable DB/browser/provider/upgrade/rollback, real cap race, money parity, permissions, John PQ/UAT and all private pack proofs complete; actual release gate evidence accepted for independent review. | Code + reviewer; John process | Skipped/missing/old-head mandatory proof, fake report, failed high-risk row or unmet separate proposal condition: STOP. Do not run synthetic suites on live. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-19 Rhys completes C04 VSR and individual C05 residual decisions with independent review; John accepts process. Record separate operational GO for the exact company/version/features/window and final stop/cut-off/recovery owner. | Rhys + reviewer; John acceptance | Unsigned/not approved, unmet condition or expired window: keep closed. Gate/report alone grants no approval. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-20 After separate recorded authority, open only agreed features/writers in the reviewed order; run the approved six smoke checks and controlled G8 opening flow, actual primary/cover admin-code checks and right-company/record/mail/provider checks. Trial writes/sends only if specifically approved; retain results. | Code opens; Rhys + John check | Unexpected send/export/access/company/money/time/duplicate or missing smoke result: pause affected use immediately. Optional AI/accounting remain off without permission. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |
| C16-21 John confirms staff/paper fallback/contacts; each named owner resumes ONLY their approved writer after accepted results. Rhys records final permission for routine use, observation owner and first review time. | Rhys final GO; John; each resume owner | Missing check, unknown queued work, unclear authority or unnamed monitor: do not resume routine use. | [ ] GO [ ] STOP · time ____ actual ____ file ____ initials ____ |

Final operational choice: [ ] GO for exact recorded scope [ ] STOP; scope/reason/conditions ____; Rhys signature/time ____; John signature/time ____; reviewer ____; Code ____; private evidence index ____.

**On failure:** keep agreed writers stopped, save last completed step/output and actual state, notify Rhys/reviewer; no blind rollback, resend, re-import or wipe. Review rollback dependency order 146/145/144/141/140/138 only under its separate recovery decision and applicable guards. After 146 rollback, STOP: never reapply it on that database, delete retained history/key_source or fake reservation settlement. A live restore must contain required state and reconcile later work/Marpet impact; an older backup cannot invent it. A refused 140/141 rollback is not permission to delete source-reference/WIP data. A fresh test rehearsal needs an authorised disposable restore/reset, never a real-data reset workaround.

## Sources and L9 handover

Release/check paths/order are from `supabase/release-plan.json` at `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. Controls consolidate `tests/CUTOVER-DAY-CHECKLIST.md` (#315), corrected restrictions (#322), exact kit gates (#337), fresh-checkpoint week plan (#333), C03 and the existing independent evidence/recovery guides. They do not adopt the older CP's 6/15/9 count as a new scope decision; C04 records the explicitly approved protocol revision/counts.

Builder 6 / atomic claims/L9, 4 November 2026. Checked six ordered release/verify paths exist, numbered gates/owners/evidence/stop points, fresh backup and protected-state logic, and whitespace. This sheet was not executed; all operational ticks, evidence, authority and signatures remain blank. Documentation only, no new scope, main merge, production SQL, deployment or Ready label. Rhys/Code/reviewer review the exact plan and prove every prerequisite next.
