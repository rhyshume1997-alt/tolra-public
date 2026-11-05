# JNR and Marpet ISO pack comparison

DRAFT v0.1, 5 November 2026. Review only. Company approval, procedure use and record retrieval: **NOT EXECUTED**. Software and documents cannot make a company certified. Each company gets audited. An adviser must assess the real system against the licensed standard; this is not a certification-readiness verdict.

## What the public set already contains

Sources are pinned in [public-source-index.json](public-source-index.json), with exact SHA, path, blob, line count and text hash. GitHub source links use `https://github.com/rhyshume1997-alt/tolra-public/blob/<sha>/<path>` from that index. Only public documents were read. No operating records, private files or company systems were inspected.

| Public PR | Content compared | Finding |
| --- | --- | --- |
| #335 | Clause map 4–10 | Generic JNR support/gap starting point; not proof of use |
| #336 | Controlled register and revision procedure | Public inventory is not either company's controlled master list |
| #337 | Wipe-day runbook and coordination docs | This is not an ISO pack PR; do not count it as a missing ISO procedure |
| #338 | Policy and objectives | Already covered by company QMS 002–003; decisions/results remain blank |
| #339 | Eight procedures | Company 008–009, 011–014, 017–018, 020–022 cover these areas |
| #340 | Risks and opportunities | Company 007 exists; actual risk assessments/acceptance are not evidenced |
| #341 | First audit and review | Company 021–022 exist; no completed audit or minutes evidenced |
| #360 | What John must decide | JNR decision prompts already exist; no signed decisions evidenced |
| #361 | Quality-record evidence map | Each company has TOLRA-EVIDENCE-MAP.md, with use/retention/approval unproven |
| #363 | Auditor export checklist | General JNR checklist exists; company-specific result sheets added here |
| #366 | Word copies/index | The visible Word set lacks copies of #360, #361, #363; three source-text copies added here |
| #371 | Marpet pack at 307f90a40f5f70ff3b2f704bf99f98aabf6dac86 | All 28 numbered drafts exist; use of Tolra remains NOT VERIFIED |
| #372 (extra relevant source) | JNR pack at 31233db64f2a01a6b2e68468c8b123b825db2e47 | All 28 numbered drafts exist; not in the requested list, but needed to compare JNR fairly |

Both company sets contain scope, policy, objectives, responsibilities, context, process map, risks, document/record control, order review, design applicability, suppliers, purchasing, production, traceability, inspection, calibration, nonconformance, cause action, complaints, competence, audit, management review, maintenance, delivery, changes, retention, continuity and a forms index. Do not duplicate these procedures or claim calibration/design scope is missing simply because Tolra lacks a module.

## What is missing or unproven

These are evidence/adoption gaps in the reviewed public drafts. Private company evidence might exist; its absence here does not prove it does not exist.

| Gap | Public evidence | What is needed / supplement |
| --- | --- | --- |
| Actual scope and design decision | Both QMS 001/010 and questionnaires | Each company's activities/sites, applicability reason, approval; cannot invent these |
| Policy, targets and responsible people | Both 002–004; #360 | Signed policy, measurable targets, authority/deputies, communication evidence |
| Risks and process controls adopted | Both 005–007, 009–015, 024–025 | Real process map, risks/actions, order/setup/inspection/release records; adopt existing procedures first |
| Current controlled masters and retention | Both 008/026/028; #336 | Company master list, versions, approval, storage/access/retention/deletion holds; no periods invented |
| Supplier evaluation forms/records | Both 011 say evaluations/list needed | SUPPLIER-REVIEW-RECORD.md supplies a blank entry; approval criteria remain company's decision |
| Gauge and maintenance registers | Both 016/023 describe fields, not populated register entries | CALIBRATION-CHECK-RECORD.md and MAINTENANCE-RECORD.md supply blank entries; methods/intervals require competent approval |
| Issue/cause/complaint records | Both 017–019 describe logs and evidence needed | QUALITY-ISSUE-RECORD.md supplies a linked blank form; keep each issue and decision traceable |
| Competence evidence | Both 020 | TRAINING-COMPETENCE-RECORD.md supplies an observed-task record, not proof from attendance |
| Audits, reviews and effectiveness | Both 021–022 are draft procedures | INTERNAL-AUDIT-RECORD.md and MANAGEMENT-REVIEW-MINUTES.md supply blank results/actions; use existing checklists/agendas |
| Company retrieval results | #363 and both evidence maps | JNR/MARPET-AUDITOR-RETRIEVAL-SHEET.md: optional local adaptation, all results NOT EXECUTED |
| Three missing Word equivalents | #366 word/INDEX.md lists earlier set, not #360/#361/#363 | word/ copies preserve every source line, including Markdown table syntax and blanks; these are text-equivalent copies, not approved company masters. Print layout/typesetting not verified |
| Marpet's real work and Tolra use | #371 START-HERE.md explicitly says unknown | Marpet management must confirm yard/site work, subcontractors, handover and actual systems; JNR evidence cannot stand in for Marpet |

## How to use the new blanks

Each record template has requirement ID, expected result, actual result, evidence reference, tester, date and approval. Blank results stay NOT EXECUTED. Make separate private copies for JNR and Marpet; choose the owner, local reference, version and review date before adoption. Do not overwrite Code's company packs or issue these as new QMS numbers. Update the adopted company forms index only after company approval. Keep links to original records; do not upload real details here.

Seven shared blank record forms and two company retrieval sheets are supplied. These fill practical form-entry gaps; ISO does not require these exact extra file names. The three Word copies are formatting supplements to the public JNR sources and must not be renamed as Marpet procedures without review. All unapproved source wording remains unapproved.

John/JNR management decide JNR scope, policy, owners, methods, records and acceptance. Marpet management decide Marpet's equivalents. Rhys confirms technical facts and access. A competent ISO adviser helps assess applicability and readiness; the certification body decides certification. Nobody's signature, result or approval is filled in here. No messages were sent to either company.

## Verification

`python3 -m unittest discover -s tests/reviews/iso-pack -p '*_test.py' -v`

Checks cover public-inventory completeness for the compared numbered drafts, all nine blank record structures, and exact visible-line parity of the three Word source copies. These are document checks, not ISO audits. See tests/reviews/iso-pack/evidence for run metadata/logs. Real adoption, retrieval, operating effectiveness, print appearance and certification readiness remain unproven.

Prepared: Codex public-source review. Human reviewer: ______. Review date: ______. Approval/signature: ______. Adoption: NOT EXECUTED.
