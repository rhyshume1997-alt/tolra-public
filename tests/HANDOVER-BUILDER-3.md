# Builder 3 handover for Claude Code — 4 November 2026

## Latest queue: M1–M4 — 4 November 2026 (Europe/London)

Rhys explicitly assigned four jobs, draft PRs only, one per job. Atomic claims/M1–M4 created after ownership/open-PR/ref checks; no existing claim overwritten. All four delivered and committed; original builder6 #350–#354, builder5 ISO masters, #359 delivery implementation and held importer branches unchanged. No main merge, production SQL, live import/send, deployment, Ready label or new feature. Build/test deadline Fri 6 November; conditional go-live Thu 12 November.

### Done

- M1 #362: Independent second source review of all five #350–#354 files,21 findings/corrections,452 unfilled source-table rows; 189 existing C03 IDs and125 canonical fields retained.
- M2 #364: docs/handover/SLIQ-LOAD-RUNBOOK.md: reported .xls/row 6/footer conversion controls,2035+2= 2037 October baseline, final/delta controls and complete unpaid/aged-debtors three-way tie-out.
- M3 #365: docs/handover/DELIVERY-NOTES-UAT-JOHN.md:18 required goods-out checks plus exactly six John questions; create/number/print/PDF/email/job/customer/receipt controls and actual blocker visibility.
- M4 #367: docs/iso9001/JOHN-PACK-GAPS.md:30 owner/evidence/timing actions; all 14 I7 feature gaps and18 source files covered; actual company adoption remains open.

| Job / draft | Exact head | Branch → target | CI snapshot |
| --- | --- | --- | --- |
| M1 / [#362](https://github.com/rhyshume1997-alt/tolra-public/pull/362) | `7f3a8d48e7bc498628c175e62ed50419b4841856` | `codex/m1-second-review-c03-c16` → `main` | [41887095613](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41887095613) completed, success |
| M2 / [#364](https://github.com/rhyshume1997-alt/tolra-public/pull/364) | `83a2826b29ca6fdb139f4a0e7812d103865426be` | `codex/m2-sliq-load-runbook` → `main` | [41887740603](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41887740603) completed, success |
| M3 / [#365](https://github.com/rhyshume1997-alt/tolra-public/pull/365) | `1970388d390df9f8c8af9dcd7d94d1d5f71aa174` | `codex/m3-delivery-note-uat` → `main` | [41888283373](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41888283373) completed, success |
| M4 / [#367](https://github.com/rhyshume1997-alt/tolra-public/pull/367) | `a23e3041e75ec5a90dc2bb66f68247614ea77c7f` | `codex/m4-john-iso-pack-gaps` → `main` | [41888854407](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41888854407) completed, success |

All four documentation CI runs completed success at this snapshot. These are docs/source/inventory checks, not new runtime, original-file inspection, UAT, financial reconciliation, company audit or acceptance evidence. No full/unit/browser/SQL suite was rerun for this documentation-only queue. No signature/result was filled.

### Source and verification record

- M1 reviewed every line at #350 **ad4f506606689292edbd68d5390b864d0b3d7e83**, #351 **de2642cb59fa3910d1fb2b0f112fe656da9737c9**, #352 **c52e145e32e9026318154751d03be199019d30a2**, #353 **034ef62ebba6d882c92c351802dd9c3ba5ffc02c**, #354 **e22c975c6eb1bcfba667a331d8aa1d5536c3be46**. Rechecked once before handover: all source heads unchanged. New PR carries corrected copies of all five plus M1-SECOND-REVIEW-350-354.md and M1-OPEN-ITEMS.json under docs/handover/. Do not overwrite corrections with original sibling drafts when assembling papers.
- M1’s 21 findings include fake-only technical versus manual-real-data targets; missing 45-minute break fixture; overbroad screen AI-off proof; authenticator AAL2 versus email ticket; live DAY action boundaries; per-device roles and separate signers; older RISK-015 transfer scope; required delivery-note risk; .xls/header-row 6/totals/Crd/VAT/aged/quote/PO shape handling; actual-production-loader proof; and C16 circular prerequisites/GO-before-smoke. C16 now uses stage prerequisites, limited controlled access then smoke, then final VSR/residual/process signatures and final routine-use GO before named writer resumption. All future checks remain visibly open until done.
- The source templates’ 452 unfilled table rows are individually recorded by original head/path/line/ID. Rhys/John/reviewer signature lines already present in C04 remain blank; missing specific technical/accountant/mitigation-owner acknowledgments added separately. A separate **verbatim reviewer conditions register/private Operations Pack was not available**: C03/C04/C05/C16 intent is checked against the supplied job scope and visible source, not falsely declared closed against unseen subconditions.
- M2 shape/count facts come from Rhys’s instruction, not inspected files: report-style .xls, titles/header row 6/totals, DD/MM/YYYY, Total includes 20% VAT; 2035 invoices plus 2 Crd = 2037 baseline document rows through 13 October 2026; 79 customer rows; supplier/payment/quote/PO/quote-item/aged reports. Monetary totals, actual source IDs and final November counts were not supplied; they stay blank. Need complete fresh final set or separately reviewed 14 October→actual cut-off delta including edits/credits/payments to older records. Do not load full+delta twice.
- Existing importer source inspected at e7581c43: load.mjs CSV/XLSX first-nonblank header, no legacy .xls/report-title/footer support; mapping provisional with unmapped credit/allocation headers; guard/write require disposable rehearsal identity and reject production/hosted targets. Quote lines **are supported** through the shared document-line mapping and quote_line_items write path when parent identity is unambiguous. PO headers carry empty items. Jobs/orders/deliveries and extra comparison reports do not thereby gain writer features. Need actual proved converter/normalization lineage and reviewed operational loader; never add live rehearsal markers, disguise target names or relax guards. #355’s separate safeupdate/RPC proof is a scoped source, not these real file shapes or cutover approval.
- M2 requires original→normalized→accepted/held/excluded row accounting, target-before/after/ID-map controls, separate invoice/credit/payment/refund/allocation money, no double credits/opening balances, and all unpaid invoices in both directions. Aged debtors must tie at matched as-of date/scope/age buckets/account/grand total via reconstructed source and independently extracted Tolra balances, including unapplied credit/cash and explicit bridge. No zero inferred from missing report, no extra VAT on gross, no historic penny re-rounding. Ordinary-money rule and protected costing half-even/60 golden exception unchanged.
- M3 source #359 **4991e0882bab8f4b349fc6aaf8b0c851deed0ca8**: actual UI labels/role boundaries, by-hand invoice-derived versus next DLN numbering, text versus real job_id links, print/PDF/pack and controlled-email behaviour. #359 still reports no starting-number setting and no direct job route without sales order. Required route missing/refused is a business gap, not a passing safe refusal or automatic N/A. No SQL counter/placeholder import/new RPC commissioned. Exactly six questions cover pad/wording, paper-to-system numbering, required job routes, partials/returns, role/release authority and copies/email/receiver evidence. Eighteen rows remain unrun; signed customer receipt is not a typed label.
- M4 read 18 public source files across #335,#336,#338–#342 at the heads listed in the new document. Thirty actions cover whole-pack company decisions plus all 14 I7 feature-gap topics, required delivery notes and real transfer controls. Existing private JNR controls may already answer a row; “OPEN” means not evidenced in this public pack, not that the company lacks it. John/competent quality adviser confirm actual scope/edition/amendment/climate relevance and customer/legal duties. Do not treat software, templates or CI as ISO certification. Controls necessary for relevant current work cannot wait for optional future modules; audit/review dates follow real obligations/risk, not invented intervals or automatic deferral past go-live.
- Static verification actually passed: 21 unique findings; 189 check IDs retained in exact order; 125 canonical fields retained in exact order; 452 original unfilled rows inventoried; 2035+2= 2037 arithmetic/report boundary; M3 exactly 6 questions/18 unique row/result sets; M4 30 actions/14 gap crosswalk/18 exact source paths; all 10 deliverable files whitespace. Scripts/snapshots local under /workspace/work/queue-m; they are source/inventory checks, not permanent redundant tests. Original /workspace/tolra-public checkout remains clean on main 68f89ca7.

### In progress / blocked — next for Code, John and Rhys

1. Independent reviewer checks #362 corrections against the actual verbatim C03/C04/C05/C16 conditions and complete private Operations Pack. Reconcile any unseen condition, named signatory, required protocol/private row and final scope before saying those conditions are closed. Integrate corrected papers once; preserve older evidence attached to its own head.
2. Obtain untouched real .xls/report originals, hashes, actual headings/filters/IDs/totals and final cut-off. Prove deterministic supported conversion and mappings, Crd sign/credit de-duplication, real line/payment/PO preservation and complete count/money/aged-debtors bridge. Identify a reviewed operational loader for all required records; rehearsal CLI cannot be repurposed for live. Missing route/source/money proof blocks load/use. John/accounts/Code/reviewer/Rhys sign their own responsibilities.
3. John supplies pad photo and six answers. Code/Rhys resolve required numbering/no-sales-order job/linking gaps under separate existing ownership/review, not by this checklist building a feature or counter bypass. Complete actual device/create/number/partial/release/print/PDF/email/receipt/job/customer/permission/save UAT and sign. Delivery notes are required at opening, not silently deferred; keep a controlled reconciled handwritten process until the accepted replacement is proved.
4. John appoints ISO document/process owners and competent checker, reconciles private masters, adopts only suitable procedures and supplies actual policy/objective/risk/training/gauge/supplier/physical traceability/NC/release/record evidence. Plan/perform actual audit and management review when obligations/risk require. Complete M4 per-row evidence/signature/owner/due fields; a complete list is not completed company evidence.
5. Existing final-version SQL/browser/provider/race/parity/upgrade/backup/restore/exact wipe/import/preservation and independent VSR/operational conditions remain. Preserve required 138/140/141/144/145/146 order and **no 146 reapply after rollback/history/key_source bypass**. No production operation approved by any of these drafts. Historical 52/61 broad audit remains stopped.

### Not started

No job beyond M1–M4. No real file conversion/load, true financial tie-out, customer dispatch/email, physical print/device check, company audit/review/training/calibration, actual signature or risk acceptance, production SQL, counter/placeholder write, deployment, merge/closure/retarget or Ready label. No new importer/delivery/ISO module built. NO GO / NOT VALIDATED remains until actual required proof and independent human decisions are complete.

## Earlier queue handovers (preserved)

## Latest queue: B4/D5, G9/C6, CY, CZ, DA, DB — 4 November 2026

Rhys explicitly assigned these six documentation/review jobs, one draft per job. Claims/B4, D5, G9, C6, CY, CZ, DA and DB were created atomically after checking existing refs/ownership/open PRs. G9/C6 here is only the export-request document; held SliQ implementation owners and all original branches remain unchanged. No new feature, main merge, production SQL, deployment, Ready label, message send or signature. Friday 6 build/test deadline and Thursday 12 go-live target retained. This section supersedes older queue priorities below, which remain history.

### Done

- B4/D5 #319: 18 per-device click/expected rows with Pass/Fail/Not run and signature; source/navigation/role boundaries checked.
- G9/C6 #320: 440-word export handout, sixteen exact code-header/fake-row examples and unsent Rhys message with no full stops/em dashes.
- CY #321: 490-word Monday agenda: ten decision/evidence rows, Monday preparation decision distinct from final Thursday GO.
- CZ #322: 27 visible R-key occurrences reviewed; eight corrected proposals, source ledger, CS R8 correction and version notice in older CO.
- DA #324: All47 PR numbers classified:41open,6closed unmerged; unique code/docs/evidence and conditional closure rules.
- DB #333: Six dated rows: Fri 6 backup/restore, Sat7 conditional wipe, Mon9 meeting, Tue10/Wed11 codes, Thu12 cutover; each has STOP.

| Job / draft | Exact head | Branch → target | CI snapshot |
| --- | --- | --- | --- |
| B4/D5 / [#319](https://github.com/rhyshume1997-alt/tolra-public/pull/319) | `ae5564652c09af54d09f0b67baed3f9211cf5546` | `codex/b4-d5-john-device-uat` → `main` | [41841871211](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41841871211) completed, success |
| G9/C6 / [#320](https://github.com/rhyshume1997-alt/tolra-public/pull/320) | `bf664425f819677b6f4256e627444940164f0793` | `codex/g9-c6-sliq-export-request` → `main` | [41842418634](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41842418634) completed, success |
| CY / [#321](https://github.com/rhyshume1997-alt/tolra-public/pull/321) | `09ca7ea87fa8c8dc7839c33f5e1813b313adfc6d` | `codex/cy-go-no-go-meeting` → `main` | [41845171602](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41845171602) completed, success |
| CZ / [#322](https://github.com/rhyshume1997-alt/tolra-public/pull/322) | `1b4ed92dcd4337e2c0bde4c67520ac3055aba72e` | `codex/cz-restriction-claims` → `codex/ba-first-day-41-evidence` | [41843717998](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41843717998) completed, success |
| DA / [#324](https://github.com/rhyshume1997-alt/tolra-public/pull/324) | `19b1d6a3f09502d798c1d09618cefa3f17f8cc01` | `codex/da-codex-merge-order` → `main` | [41844705802](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41844705802) in_progress, no conclusion |
| DB / [#333](https://github.com/rhyshume1997-alt/tolra-public/pull/333) | `8ca0aac7067bade11de78272f46d4a19aa0dab5f` | `codex/db-rhys-cutover-week` → `main` | [41844856929](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41844856929) completed, success |

CI statuses are snapshots. DA remains in progress at handover; no green result assumed. The five successful documentation runs do not prove a UAT, SQL/browser/backend, physical print, private backup/import/restore, provider receipt or signature. No runtime suite was repeated for this docs-only queue. Prior CV results stay pinned to e7581c43 and a4c89af3, not these new heads.

### Checks actually completed

Source/inventory verification passed: 18 unique UAT rows with 18 result sets; sixteen CSV example blocks with matching header/value widths; message has no full stops/em dashes; ten agenda questions; eight unique proposed R rows with blank acceptance; all 27 visible R-key-bearing lines inventoried; 47/47 PR numbers and actual file lists, 41 open/6 closed; six dates/weekdays correct; primary files have no trailing whitespace. Sources, assumptions and actual missing results are distinguished in each file. Source checks were a Python inventory/CSV/calendar check under /workspace/work/queue-b4-db; no artificial permanent document tests or broad behaviour audit were added. Physical one-page printing remains to check, not claimed passed.

### Material findings and integration limits

1. **SliQ:** importer mapping sliq.json at inspected e7581c43 is provisional/unconfirmed; credits/allocations have no mapped headers, stable party/paid/VAT fields need actual mapping. Ten writer input kinds are distinct from six comparison-only kinds. jobs/sales_orders/delivery_notes are not written by the existing writer; do not promise automatic transfer. John sends untouched original exports/headings, a practice set by Fri 6 and fresh complete final set after agreed cut-off. Code confirms real headers/dates/encoding, resolves held rows, WIP/next numbers and complete comparisons before independent import authority. The sixteen examples are fake format examples, not a coherent accepted import dataset. The short Rhys message is only saved draft text; it was not sent.
2. **CZ:** read all 14 refreshed validation files at f76a5b84da1f01626cc81d17150e08e6069ef794 and all 17 builder pack files outside generated evidence at #3179515eda3. Exact application/test source read at the refresh’s declared9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8. All 27 visible R1–R8 references are in docs/handover/R1-R8-OCCURRENCES.json. No docs/handover files existed in the checked public main 68f89ca7/#24741c685c4/#3179515eda3/f76a5b84 trees; unseen private handover remains unreviewed. Supply that tree if intended. New restriction document is a corrected docs-only extraction; do not merge diagnostic application code/manifests/counts.
3. Corrected R claims: no unsupported “proved/validated/rehearsed”; no Sage/QBO export promise; no pre-filled Accepted; disposable reset distinguished from live recovery; existing caps/usage preserved, default £10/max £1,000, registry owner+MFA rather than hard-coded sole Rhys; used+reserved not an off switch;142 weekday scheduling/143 costing exclusions do not remove existing timesheet-email/editor/balance checks; exact manual IDs need a decision, not auto N/A. Ordinary money half-up and protected costing half-even/60 golden unchanged. Private 38-tie result not visible and no SQL parity pass claimed. Declared CI41816512073 is overall FAILURE; selected reported passes do not complete validation.
4. **DA:** actual PR#247 head41c685c416305637d86b580324fff9e6cda037ff differs from pack-declared application9c3f5c6. Code must choose/identify the authoritative base before folds. CA140/141 release bodies differ from9c; only the two verify blobs match. Reconcile, never blindly overwrite newer guards or call a whole closed PR duplicate. Closed #272/#273/#274/#276/#278/#279 are unmerged, not evidence of integration. Preserve inherited reconciliation/gate foundations and #280 strict refusal tests; audit remains stopped 52/61. Apply #281→#289, #296→#298; adapt #297 from its distinct base. #285 remains held costing, outside cutover.
5. Keep #314 latest **ce1118393cc0d65bfde426d31222903a802984ff** BA correction: DAY10–13 settings context is CompanyDetailsCard line53, not old line589 year-end ZIP export. Keep corrected CN#286/CU#305, never original versions from CV’s aggregate. Keep #315 evidence only; #316 **359249878c17b7e4586e39bbee4b7e3961c2a2e2** final twelve sign-off masters and unique older handovers. Closure candidates are conditional on recorded replacement commit/path plus unique evidence preserved: #277/#282/#283/#294 and original twelve masters #301–304/#306–313 after#316. No PR was actually closed/retargeted/merged by this job.
6. **Calendar/authority:** Friday 6 proves dump+complete restore comparison; no proof means stop Saturday7. Saturday’s scheduled clearing needs its own separate written authority, exact-kit rehearsal/review and preservation proof; Monday cannot approve it retrospectively. If live JNR clearing is separately approved, hold agreed target writers until opening while SliQ remains source until final cut-off. Monday9 is preparation/go-no-go, not passing Tuesday10/Wednesday11 code challenges in advance. Thursday 12 needs current recovery checkpoint, fresh final exports, verified138/140/141/144/145/146 and complete final comparison before Rhys’s separate GO. Never blindly repeat Saturday clearing or146 after rollback.

### In progress / blocked — Code’s next actions

- Review DA’s current CI result and all six exact heads; retain this queue’s files in the chosen packet, including the corrected CZ restriction wording. Required affected checks must run on the eventual integrated code; historical results do not transfer automatically.
- Obtain actual SliQ exports/confirmed mapping and a reviewed route for writer-unsupported transfer data; private Operations Pack and exact 41-item match; unseen intended private docs/handover; actual backup/restore/private combined-kit/wipe/import/WIP/numbering/complete preservation evidence. Missing files are not zero or N/A.
- John performs/signs the actual desktop/workshop UAT and PQ with Code by Fri 6; check the handout/agenda print layout before use. Rhys/John complete their own business/sharing/contact/provider/retention/payroll/scope choices privately; no unsigned sheet proves acceptance. Meet Mon9, prove required admin challenges with primary/cover on Tue10 and Wed11, then separately decide Thu12.
- Actual CJ browser, N2/N3/race/security/CL PostgreSQL parity and exact upgrade/rollback/recovery proofs remain required on verified disposable/synthetic targets, separate from the protected manual real-data copy. External AI/delivery stay blocked without separate authority. Preserve the no146reapply-after rollback/history/key_source stop. No live reset workaround.

### Not started

No job beyond this assigned queue. Actual operator UAT/meeting/signature, export acceptance/import, backup/wipe/restore, admin enrolment/challenges, production SQL, live feature/provider operation, merge/closure/retarget, main push and deployment were not performed. Historical61-head audit remains stopped 52/61. Original /workspace/tolra-public is clean on main 68f89ca7; local queue artifacts are /workspace/work/queue-b4-db. NO GO / NOT VALIDATED remains until actual required evidence and independent decisions are complete.

## Earlier queue handovers (preserved)

## Latest queue: CR, CS, CT, CU, CV, BA — 4 November 2026

This section supersedes older queue-priority instructions below. Rhys explicitly assigned these six jobs and extended CR to #314 and builder 4's twelve sign-off sheets. All six deliverables are committed in one draft PR per job; no sign-off master was duplicated. Atomic claims/CR, claims/CS, claims/CT, claims/CU, claims/CV and claims/BA exist; no existing claim was overwritten. Older BA #269 remains historical; this explicit new assignment has #317. Deadline Friday 6 November, go-live Thursday 12 November 2026.

### Done

- CR #298: Review #290–#297, #314 and twelve sign-off sheets; cap/path fixes plus exact CN/CU corrections retained.
- CS #299: 41 fillable VSR cells and eight proposed restrictions mapped to exact refreshed file/line evidence; missing actual results marked.
- CT #300: All 64 expanded IDs mapped across original 35, refreshed 60 and builder 64 revisions; no invented signed scope.
- CU #305: Six short smoke rows; exact #314 MFA/AI-off corrections retained.
- CV #315: Local lint/types pass in both contexts; candidate 5622/5622 and isolated CM 5357/5357, zero failed/skipped/todo.
- BA #317: All 41 public first-day boxes mapped; 41 exact Operations Pack matches missing, actual execution NOT TESTED.

| Job / draft | Branch | Current head | CI snapshot |
| --- | --- | --- | --- |
| CR / [#298](https://github.com/rhyshume1997-alt/tolra-public/pull/298) | `codex/cr-builder4-review` | `8d161eca667cf3a64b4a9aaffb2df6ddba9d673d` | [41839489160](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839489160) in_progress, no conclusion |
| CS / [#299](https://github.com/rhyshume1997-alt/tolra-public/pull/299) | `codex/cs-vsr-evidence-index` | `ecbf38f36bd4a57a9a93916bb51849b96e239cd5` | [41834666089](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41834666089) completed, success |
| CT / [#300](https://github.com/rhyshume1997-alt/tolra-public/pull/300) | `codex/ct-manual-count-map` | `49097c56f05e690b811872e24ff9b159b774f334` | [41834921405](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41834921405) completed, success |
| CU / [#305](https://github.com/rhyshume1997-alt/tolra-public/pull/305) | `codex/cu-first-day-smoke` | `78dc5b7033592f20640b15e61b198c7fcf17930e` | [41839392247](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839392247) completed, success |
| CV / [#315](https://github.com/rhyshume1997-alt/tolra-public/pull/315) | `codex/cv-current-stack-checks` | `727ff228b6bc8575bc4440f409fdd3c41fe4ce5e` | [41839013622](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839013622) in_progress, no conclusion |
| BA / [#317](https://github.com/rhyshume1997-alt/tolra-public/pull/317) | `codex/ba-first-day-41-evidence` | `9515eda33b50878a057a431b06498a5b1f15b204` | [41839231198](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839231198) completed, success |

CI is a timestamped snapshot, not proof that skipped integration ran. CR's preceding head e1359613 run 41837435184 had web success (including lint/types/unit/build/collection), integration skipped and overall ci-gate failure because the full integration suite had not run. Current CR/CV pending results above are not promoted to success. No Ready label or workflow bypass was used.

### Exact source and test boundaries

- CS successfully read Code's diagnostic/proposal branch `claude/258-refresh` at **f76a5b84da1f01626cc81d17150e08e6069ef794**. It declares application code **9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8**. Do not merge that diagnostic branch. The refreshed form is 6 IQ / 14 OQ / 8 PQ; the older builder form is 6/15/9. R1–R8 are defined proposed restrictions in that refreshed file, unlike the older undefined standalone audit labels in CO. No acceptance/signature was found. CURRENT-RESULTS.md returned 404; actual protocol evidence and private rounding reconciliation were not visible. Use tests/validation/EVIDENCE-INDEX.md for all exact links and gaps; it does not fill Rhys's form.
- CT sources: original #248 **a38ffd683c370788fa1c3d98a324081c08d37950** has 35 rows; f76a5b84 has 60; builder #289 **bcf29b1589dfe9a15a593c583984e6c457690b1d** has 64, including four G15 transfer gates. tests/validation/MANUAL-35-VS-64.md maps all 64. Rhys's final accepted revision is not visible; selecting a smaller form cannot waive transfer/cutover proof.
- CR read #314 **bbf21d67ca87c5d161022d149f2ef0ea5ec62ad7** and all twelve source-pinned sheets #301–#313 excluding #305. Exact heads/findings are in tests/CR-BUILDER-4-CROSS-REVIEW.md. No additional error found in those twelve sheets for their stated scope; all remain unsigned, and live portal/business/runtime evidence is open. Original cap/path corrections remain. The exact corrected #314 CN/CU blobs were retained in our existing #286/#305: CN head **bfaa31b84ebb04cec74c386787806320c3dee44e**, CU head **78dc5b7033592f20640b15e61b198c7fcf17930e**. Block external AI on restored real data until separate approval; Sage/QBO are balance checks, exports Xero only; actual MFA challenge/refusal required; AI-off smoke is visible switches/assistant refusal only.
- CV tested exact candidate **e7581c43b5f92836ceaedcf2716d495392a9d9e6**, tree **a1c21e014ef0e7c201dc48d5f61b09bebd1f9ffc**. Latest main **68f89ca7b801a10587ff9b51d6c820462847b65a** was confirmed ancestor and unchanged after runs. Candidate contains CU spine and original CN/CO/CP sibling documents; later CR extension/CN/CU document corrections and BA are outside the frozen source. Integrate their corrected versions, never overwrite them with older CV documents. CV evidence commit is not itself the executed source head.
- CV Node24.22.1/npm11.9.0: candidate fresh locked install, lint/typecheck exit0, 5622 passed across 415 files; isolated CM **a4c89af3723703ba5e284bb6500553d42975f925** with supplied dependencies, lint/typecheck exit0, 5357 passed across 373 files. Both have 0 failed/skipped/todo and 3 existing lint warnings. tests/CV-CURRENT-STACK-RESULTS.md gives exact commands and tests/evidence/builder-3-cv/ retains summaries/logs/per-file counts. Initial restricted child-process failures, then candidate missing-font failure, then default npm-cache permission failure are retained honestly; writable workspace-cache locked install and supported network/loopback permission resolved environment failures without source/test/lock changes. No repeated historical audit, DB/browser/build-local claim or costing activation. Original held costing branch and half-even engine/rates/60 golden answers unchanged.
- BA's readable 41-checkbox source is docs/JNR-GO-LIVE-DAY-CHECKLIST.md at **b9d3af361e9d88ccbd2e5ab840f078c862ff3f37**. All 41 unticked boxes have immutable source lines and individual evidence requests in tests/BA-FIRST-DAY-EVIDENCE.md. This 41 count is unrelated to CS's41 cells. Exact authoritative Operations Pack is missing; public derivative is not a completeness certificate. No private ID/acceptance/result was fabricated.

### In progress / blocked — next actions for Claude Code

1. Obtain the exact versioned authoritative Operations Pack privately, with owner/date/stable reference. Map each DAY01–41 to exact pack item/page/line; document extra/changed/excluded items and supply actual dated final-version evidence, report/hash and independent acceptance. Keep real records/secrets/signatures private.
2. Combine reviewed drafts with the **corrected** CN/CU and final CR documents. CS currently branches from initial CR; CV/BA include the old CN/CU snapshots by history. Preserve final documents explicitly when integrating. Do not merge f76a5b84 diagnostic code. Reconcile protocol/manual/cutover scopes and restriction proposals before Rhys signs.
3. Review current CR and CV CI runs; successful local unit commands and docs CI do not clear skipped integration or missing final combined-head proof. Run only required final checks on the actual integrated candidate. Historical61-head audit remains stopped at 52/61.
4. On an independently verified fake disposable backend, complete CJ browser specs, CL real PostgreSQL rounding parity, named N2/N3 race/MFA/permissions/provider/DB proofs and exact reviewed wipe/archive/recovery/import checks. Current local Docker socket remains unavailable; this queue executed no SQL. Keep automated synthetic target separate from protected manual real-JNR practice copy; external delivery/AI blocked unless separately approved.
5. John/Rhys must run actual manual/PQ, business, consent/contacts/provider/payroll/retention decisions and sign their own reports. Complete real backup/restore, SliQ mapping/load/WIP/numbering/reconciliation and cutover authority. Twelve unsigned builder4 masters and blank VSR are not approvals. 146 rollback retains history/key_source: STOP; never reapply 146 on that rolled-back database or delete history to force it.

### Not started

No new job beyond the assigned queue. Actual first-day operation, real John/Rhys protocol execution, private pack reconciliation, live provider/portal actions, production SQL, main merge, deployment and signing were not performed. No Ready label, production access, financial change or new feature. Original /workspace/tolra-public checkout remains clean on 68f89ca7; exact local evidence workspaces/logs are under /workspace/work/queue-cr, /workspace/work/cv and /workspace/work/cm. NO GO / NOT VALIDATED remains until the missing operational evidence and independent decisions are complete.

## Historical queue handovers (preserved)

## Latest queue: CM–CQ, 4 November 2026

This section supersedes the older “continue only CJ/CG/CH/CL” instruction below. Rhys explicitly assigned CM, CN, CO, CP and CQ. All five jobs are committed in separate draft PRs. Claims/CM through claims/CQ were created atomically; existing owner implementation branches were not reassigned. No new scope, main merge, production SQL, Ready label, deployment or broad audit was performed. Build/test deadline remains Friday 6 November; go-live target Thursday 12 November 2026.

### Done

- CM #285: one-line default-argument fix in `tests/support/costing-proposal-setup.ts`. It reads the same two existing process environment values at call time without assigning ProcessEnv to the weak Environment type. Original held source `6431e60284a4591ab6c9552de5bc0dd0468973f3` reproduced TS2559 at (20,46). After fix, `npx tsc --noEmit` passes. `npx eslint app components lib tests/support/costing-proposal-setup.ts tests/unit/costing-proposal-setup.test.ts` passes with 0 errors and 3 existing warnings (job-photos, rework-dialog, offline/outbox). `npx vitest run tests/unit/costing-proposal-setup.test.ts`: 9 passed, 0 failed/skipped. No costing calculation, rate, golden answer, SQL or assertion changed. Draft targets the held branch; the original branch is still unchanged pending review.
- CN #286: `tests/JOHN-PQ-RUN-SHEET.md`, plain click/expected-result steps and Pass/Fail/Not run boxes for PQ-001–008, using a protected private copy of real JNR records with Code beside John and delivery blocked. Static check: 8 source headings and 8 result boxes. Current PQ.md/VSR actually plan 9 checks; PQ-009 remains explicitly separate, never silently omitted. John signs his own sheet, not Rhys's decision.
- CO #287: `tests/RHYS-SIGN-OFF-GUIDE.md`, every VSR field/result/deviation cell, evidence-file source, 6/15/9 count rule, decision choice and signature line. Sources reviewed against the actual VSR, protocols, risk register and evidence files. The repo has no canonical R1–R8 sign-off key; older standalone R1/R2/R3/R4/R5/R7 audit references are cited with their actual scope, and R6/R8 explicitly remain undefined in the reviewed public candidate. Do not equate them to RISK-001–015 or unrelated #6/#8 tests. No actual template, acceptance or signature was filled.
- CP #288: `tests/CUTOVER-DAY-CHECKLIST.md`, 25 ordered rows with owner, action, GO/STOP conditions and evidence boxes. Confirmed Thursday 12 November date and all six release paths/order 138/140/141/144/145/146. Incorporates the real GO-LIVE-DATA-LOAD process and exact combined-kit protections; fake wrapper is not an importer. STOP after any 146 rollback; never reapply on that database or remove retained history to bypass guards. No step was executed.
- CQ #289: read the 11 actual changed files in #281–#284 once against immediate source/manual/money context. Corrected N1's missing Hours/day view, planned daily totals/reload/break explanation; retained existing weekly/two-company assertions. Corrected full evidence paths and stale backend directions, 12 misleading reviewer-check paragraphs, and the four reviewed source-head/CI references. Retained all 148 historical packets; no new all-open inventory. Verified 22 N2/N3 rows and 30 exact proof titles. `tests/CQ-REVIEW-281-284.md` records source heads, findings and limits. No CL arithmetic or protected costing source/fixture changed.

### Exact committed heads / CI snapshot

| Job / draft | Branch → target | Head | PR-triggered CI |
| --- | --- | --- | --- |
| CM / [#285](https://github.com/rhyshume1997-alt/tolra-public/pull/285) | `codex/cm-costing-typecheck` → `codex/costing-sql-test-plan` | `a4c89af3723703ba5e284bb6500553d42975f925` | [41827875158](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41827875158) completed, failure |
| CN / [#286](https://github.com/rhyshume1997-alt/tolra-public/pull/286) | `codex/cn-john-pq-run-sheet` → `codex/cl-rounding-rule` | `50b1877982808084aed13b2c0eced461d48dd7f6` | [41828333822](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41828333822) completed, success |
| CO / [#287](https://github.com/rhyshume1997-alt/tolra-public/pull/287) | `codex/co-rhys-sign-off-guide` → `codex/cl-rounding-rule` | `4b134cbb3f04f63938ef4537e122a43b8af6235f` | [41828752369](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41828752369) completed, success |
| CP / [#288](https://github.com/rhyshume1997-alt/tolra-public/pull/288) | `codex/cp-cutover-day-checklist` → `codex/cl-rounding-rule` | `ce2e6cc1268e5965a490f839083ab0fcd17eeae7` | [41829266489](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41829266489) completed, success |
| CQ / [#289](https://github.com/rhyshume1997-alt/tolra-public/pull/289) | `codex/cq-pr-corrections` → `codex/cl-rounding-rule` | `bcf29b1589dfe9a15a593c583984e6c457690b1d` | [41830358899](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41830358899) in_progress, no conclusion |

CM CI 41827875158 has web success, integration skipped and ci-gate failure. This is not a typecheck/lint failure or a full CI pass; do not add Ready or bypass integration to make it green. CQ was still running at the snapshot and must be rechecked. Documentation CI successes do not prove database/browser/PQ checks. The PRs are all open drafts and GitHub reported them mergeable at this check; no merge was performed.

### CQ checks actually run

- `npx eslint tests/e2e/acceptance/n1-paid-breaks.spec.ts`: PASS, exit 0.
- `npx tsc --noEmit`: PASS, exit 0 on the reconstructed candidate with CQ edits.
- `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance --list`: PASS, three tests in three files.
- `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance`: FAIL in global setup, TEST_SUPABASE_URL unset, exit 1. No browser assertion or SQL ran. New Hours/day checks remain runtime NOT TESTED.
- Document/source checks: CN eight headings/result boxes; CO field/count/decision/signature/R1–R8 coverage; CP 25 ordered rows/six releases/date/rollback stop; CQ 22 mappings/30 exact titles/148 retained packet fields/four refreshed source heads. These are static checks, not completed protocols.

Local environment: Node v24.22.1, npm 11.9.0. CM source at `/workspace/work/cm` was reconstructed from local 039529b plus the exact four-file remote delta to held 6431e602. CQ source is `/workspace/work/builder3`, with captured #284 files overlaid before edits. Both use shared preinstalled dependencies; neither is a clean locked install or an exact-head CI claim. Scratch sources/scripts/metadata are under `/workspace/work/next-queue` and `/workspace/work/cq-*`. The original `/workspace/tolra-public` checkout stayed clean. No full unit suite or broad audit was repeated. Last current Docker diagnostic remains UID-1000 socket permission denied; historical ENOSPC is separate.

### In progress / blocked

- Independent review of #285–#289 and any unfinished automatic CI; no SAFE verdict is inferred.
- Actual CJ/CQ browser execution and CL real PostgreSQL parity remain blocked by the missing verified disposable backend. Do not silently skip or substitute mocks.
- Operations Pack completeness, N2 real MFA/ACL/cap-race and N3 provider/database/browser evidence, backup/restore and real transfer reconciliation still remain open. NO GO / NOT VALIDATED remains.
- Undefined standalone R6/R8 need their original source if a reviewer intends a different eight-item list. Do not invent definitions.

### Not started here / Claude Code next steps

1. Review/apply CM #285 to `codex/costing-sql-test-plan` after independent review. It is a one-line follow-up PR, not a direct held-branch update. Preserve costing half-to-even, rates and all 60 golden answers.
2. CN, CO and CP are independent sibling one-file drafts based on #284; CQ is a separate four-file correction draft based on #284. Integrate all required approved changes into a review candidate without losing a sibling guide. Their source branches were not merged here. The CN/CO/CP cross-references explicitly require the guides to be included in the reviewed pack.
3. Recover the verified disposable backend, pin the actual final integrated SHA, install locked dependencies and run the exact changed browser command and CL DB parity command recorded above/earlier. Retain genuine command exits, counts, target identity and evidence; do not run synthetic suites against real JNR.
4. John runs the eight-check sheet on the protected copy of his real data with Code, then retains the separate PQ-009 transfer proof. Rhys and the independent reviewer complete and sign their actual VSR from genuine results. No sheet, signature or protocol was completed by this queue.
5. Rehearse the cutover checklist first on a disposable restore, retain actual private-kit/archive/preservation/import/WIP/numbering/restore/runtime proof, and obtain the separate operational decisions. This queue gives no production SQL, wipe/import, main merge, deployment or live-opening authority.
6. Do not restart the stopped 52/61 historical audit. No further new job was started.

## Earlier CJ–CL handover (historical)

Build/test deadline: Friday 6 November 2026. Go-live target: Thursday 12 November 2026. Continue only CJ, CG/CK, CH and CL. The historical CI audit remains stopped at 52/61; do not restart it. No new scope, main merge, production SQL, deployment or Ready label was performed.

Read alongside `tests/HANDOVER-CODEX-1.md` and `docs/TOLRA-WORK-OWNERSHIP.md` on coordination PR #271. Main lacks these files. Existing job drafts #281–#284 were continued, rather than duplicated. Changes were committed through the GitHub plugin because local Git/network access could not connect to the configured proxy and gh's configured token was invalid. No credential was read or printed.

## Done

- CJ #281: retained the three named acceptance specs, ran collection and attempted execution, committed `tests/CJ-BUILDER-3-RESULTS.md` with commands, environment and limits. Collection: PASS, 3 tests/3 files. Runtime: FAIL in global setup, no browser assertions executed.
- CG/CK #282: `tests/GO-NO-GO-EVIDENCE.md` now attaches proof/check file paths to all 28 gate results, 64 manual rows, 18 CW rows, six releases and 30 validation rows, plus 15 URS mappings. Retains 22 named N2/N3 mappings and every missing runtime condition. Private CW checklist path is pinned to #250, not claimed integrated. Checked inventory coverage with `/workspace/work/enrich-evidence.py`; documentation checks only. Authoritative Operations Pack is still missing, so full undisclosed-pack coverage cannot be certified.
- CH #283: `tests/REVIEW-PACKETS-NEXT.md` covers all 148 open PRs from two API pages. Each has a full snapshot head, actual PR-triggered CI IDs/status, reviewer checks and verdict request. This is metadata collection, not code audit or test execution. All 148 packet/head/CI fields checked. Snapshot heads may move; refresh from this companion and live GitHub before review. No PR comments were sent.
- CL #284: retained `tests/ROUNDING-RULE.md` and added `tests/fixtures/money-rounding-cases.ts`, `tests/unit/money-rounding-rule.test.ts`, `tests/db/money-rounding-parity.test.ts`. Normal-money positive halves round up: 0.135 -> 0.14; existing negative half-away convention remains documented. PostgreSQL test uses real numeric SELECTs and verified disposable identity, with no optional skip, DDL or business writes. It compares scalar, product and per-line VAT results to both fixed pence and app functions. No app calculation, costing engine/rate or any of its 60 golden answers changed. Costing keeps half-to-even as the deliberate exception. The optional offline CC half-even helper remains a visible non-costing reviewer condition.
- Preserved the existing PR stack by carrying CJ evidence into CG/CK, then CG/CK into CH, then CH into CL. These are branch-only integration commits, not GitHub PR merges or main changes. Later drafts no longer undo the upstream documentation updates. Existing owner branches remain untouched.

## Exact commands and observed results

| Command | Result |
| --- | --- |
| `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance --list` | PASS; 3 tests in 3 files |
| `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance` | FAIL, exit 1; TEST_SUPABASE_URL unset in global setup; runtime NOT TESTED |
| `npx vitest run tests/unit/money-rounding-rule.test.ts tests/unit/money-decimal.test.ts` | PASS; 29 passed, zero failed/skipped (21 new + 8 existing) |
| `npx vitest run -c vitest.db.config.ts tests/db/money-rounding-parity.test.ts` | FAIL, exit 1; 1 failed/0 skipped at missing-backend identity guard; no rounding SELECT ran |
| `npx eslint tests/unit/money-rounding-rule.test.ts tests/db/money-rounding-parity.test.ts tests/fixtures/money-rounding-cases.ts` | PASS; no findings |
| `npx tsc --noEmit` | PASS, exit 0 |

The first money invocation also ran `tests/unit/money.test.ts` with the 21 new cases: 38 passed. It included a nonexistent `tests/unit/money-edge.test.ts` argument, which contributed no tests; the precise subsequent command above checked the intended decimal suite. Do not combine these counts into a new full-suite claim.

Local workspace: `/workspace/work/builder3`, reconstructed from main 68f89ca and public #284 comparison, with shared preinstalled node_modules; not a clean locked install or exact-head CI proof. Scripts and metadata scratch files are under `/workspace/work/`. Original `/workspace/tolra-public` was not edited. No final whole suite, build or real backend check was claimed.

Current environment blocker: the explicit managed Docker socket check failed permission denied; UID 1000, dockerd PID 253 running. Docker command: `env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock info --format '{{.ServerVersion}}'`. Exit 1. No root/daemon restart attempted. Earlier ENOSPC is historical, not this run's current diagnosis.

## In progress / blocked

- Independent review of all four drafts; no SAFE verdict or release approval inferred.
- CJ browser acceptance and CL real PostgreSQL parity: supplied and attempted, blocked by the unavailable verified disposable backend.
- Automatic CI at final heads: snapshot below; uncompleted runs must be rechecked. CI success can have skipped integration jobs, so it is not DB/browser proof. CJ run 41825174221 failed ci-gate with web successful and integration skipped; no Ready workaround was used.
- CG/CK completeness awaits the authoritative Operations Pack and real final-head results. NO GO and NOT VALIDATED remain.

## Not started here / next steps

1. Recover managed environment Docker/socket access; prepare the independently verified fake-only Supabase/backend and app with separately reviewed 138/140/141/144/145/146. Never substitute a hosted project. This handover is not SQL approval.
2. Integrate the four draft branches in order on a review candidate; pin its actual final SHA. Rerun the exact CJ and CL commands above with locked dependencies. The CL DB test is arithmetic parity, not all document persistence/permission proof; retain existing integration/manual checks.
3. Execute remaining G04/G08/G10 manual rows, N2 real owner MFA/ACL/key/cap-race proofs and N3 all-provider SQL/sandbox/browser proofs. Three CJ tests do not cover every manual condition. Integrate held reviewer proofs separately rather than counting unmerged files as passing.
4. Obtain and reconcile every Operations Pack line; retain actual backup/restore, ordered releases/rollback, exact combined wipe/preservation/archive/refusal/disconnect, import/WIP/numbering/reconciliation and post-release browser evidence. A 146 rollback retains history/key_source and requires STOP before reinstall.
5. Refresh moved reviewer packet heads and completed CI conclusions; request independent verdicts. Rhys's validation/VSR remains unsigned. Do not resume the stopped historical audit, change costing's half-to-even answers, merge to main or apply production SQL as part of this handover.

## Final draft heads and CI companions

CI status is a snapshot, not an assertion of actual runtime coverage. The reporting file cannot contain its own eventual commit SHA; #271's description carries that SHA after commit.

| Job / draft | Final head | PR CI run / observed state |
| --- | --- | --- |
| #281 | `ff29ca191879ec954e305ec0eb200501789a5bcf` | [41825174221](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41825174221) completed, failure |
| #282 | `b80b274b0f2b8b12444915152383564cc1b9bf52` | [41826333766](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826333766) completed, success |
| #283 | `e40f9edb24a79769efd03b8f900c6c31d8a6729b` | [41826384400](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826384400) completed, success |
| #284 | `d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d` | [41826433316](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826433316) pending, no conclusion |
