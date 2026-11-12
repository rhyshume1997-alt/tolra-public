# Tolra feature gaps and JNR workarounds

Document ID: JNR-I7-ISO-9001-FEATURE-GAPS | Version: 0.1 draft | Prepared: 4 November 2026

Proposed owner: John (JNR), with Rhys for Tolra technical facts. Owner appointment, approval, effective date and next review: ____ .

Tolra supports JNR Engineering’s quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015.

## Planning position — John must approve scope

This is a source review, not an exhaustive product audit or a build request. “Before go-live” below means the proposed JNR control is needed before relying on Tolra for that work. It does not mean a feature has been commissioned or built. New software modules are proposed **after go-live**, subject to John/Rhys’s decision. No feature is built in I7. ISO 9001 does not require a particular software module.

| Need / clause | What exists and what is missing | Proposed go-live control outside Tolra | New feature timing / decision |
| --- | --- | --- | --- |
| Full nonconformance and corrective-action log (8.7, 10.2) | Job problems and inspection dispositions exist; no complete company-wide cause/action/due-date/effectiveness lifecycle found. Problem flags do not block work. | Before go-live: numbered controlled log, physical hold tags and job links; named owner follows through closure. | After: integrated log and reminders, if approved. |
| Gauge register/calibration/verification (7.1.5) | Inspection measurements do not manage gauge identity, certificates, due dates or bad-gauge impact. | Before relevant work: controlled equipment list, status labels, certs and overdue/failed-gauge impact review. | After: gauge module if useful. |
| Supplier evaluation and re-evaluation (8.4) | Approved/Conditional/Blocked list already exists. Existing/default Approved is not approval evidence; Conditional warns; unlisted PO text lacks that status warning. Scope, evidence, due review and performance workflow are incomplete. | Before buying: reviewed supplier scope/assessment list, PO identity check, receipt checks and performance review. | After: richer approval/review workflow. Do not rebuild the existing status list. |
| General controlled-document approvals/distribution (7.5) | Quote versions and drawing fields exist; no general procedure approval, controlled-copy distribution or obsolete-copy recall workflow found. | Before use: I2 register, approved master, controlled shop copies and change record. | After: general document control if approved. |
| Skills matrix/training effectiveness (7.2) | Authorised inspector scope/reason/history exists; not a whole-shop skills/training matrix or practical assessment record. | Before assigning work: controlled skills matrix, assessment, limits and expiry checks. | After: competence module if approved. |
| Risk/opportunity actions (6.1) | Validation pack covers software risks; not a whole JNR risk/action/review workflow. | Before go-live: I5 plus shop risks, owners and effectiveness evidence. | After: register/reminders if approved. |
| Internal audit programme/follow-up (9.2) | Software event history is not an audit programme, impartial audit or finding follow-up log. | Before reliance: plan auditor/scope/dates; use I4/I6 and external action log. | After: audit workflow if approved. |
| Management review/objective tracking (6.2, 9.3) | Orders/hours/inspection supply data, but no full quality-objective and management-review workflow found. | Before go-live: agree measures, owners and review plan; conduct first review with I6. | After: dashboard/actions only if useful. |
| Customer complaints/satisfaction (8.2, 9.1.2) | Customer/order history is not a structured complaint, satisfaction or returns analysis system. | Before go-live: controlled feedback/complaint log linked to jobs and actions. | After: optional integrated log. |
| CNC program/setup/drawing control (8.5) | Worksheet/drawings and version checks help; no complete controlled CNC-program lifecycle or physical copy recall found. | Before work: approved program/setup revision, prove-to-part checks and old-copy removal. | After: integration only after process agreed. |
| Physical traceability/property/preservation (8.5.2–8.5.4) | Material cert/heat fields exist; no proof of every physical lot split, label, customer tool or storage condition. | Before work: labelled batches, split/transfer records, protected property and packing checks. | After: richer stock/lot/property tracking if needed. Physical checks always remain. |
| Special processes and design, if applicable (8.3, 8.5.1) | No complete design verification/validation or welding/special-process qualification system found. | Before applicable work: John/adviser confirms scope and required plans, qualifications and records. | After: software support optional; cannot defer necessary process controls. |
| Record retention/disposal (7.5.3) | Access/history/backups help; no all-record-types retention/hold/disposal approval workflow found. | Before go-live: approved schedule, protected archive, hold/disposal control and restore proof. | After: automation only after legal/customer periods agreed. |
| Deployment/recovery assurance | Backup scripts and separate incident/rollback/validation drafts exist; live scheduling, successful restore and signed acceptance are not proved here. | Before go-live: exact installed version, operator evidence and existing approval gates; missing critical proof means hold. | Go-live prerequisite evidence; no new module requested. |

## Source basis

Existing partial features: [lib/job-problems.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/job-problems.ts); [lib/inspection.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/inspection.ts); [lib/supplier-status.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/supplier-status.ts); [lib/inspectors.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/inspectors.ts); [lib/job-worksheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/job-worksheet.ts); [lib/quote-versions.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/quote-versions.ts); [lib/audit-contract.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/audit-contract.ts); [scripts/backup-run.sh](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/scripts/backup-run.sh). Separate validation source: [tests/validation/README.md](https://github.com/rhyshume1997-alt/tolra-public/blob/e71a80072148077a4c0f05184fe40d79688c01ee/tests/validation/README.md). Reviewed public main is `68f89ca7b801a10587ff9b51d6c820462847b65a`. A missing workflow here means “not found in this reviewed source”, not a claim that JNR has no external system.

## Only John or an ISO adviser can settle

- JNR’s scope, sites, process boundaries, design applicability and customer/legal duties; required welding and other special-process controls.
- Whether these procedures fit actual practice, who owns/approves them, retention periods and suitable audit criteria/programme.
- Policy wording, meaningful targets, supplier/competence acceptance rules, inspection and concession authority, risk ratings and acceptable remaining risk.
- Whether external controls are sufficient, what gaps block JNR’s use, and whether/when new features are worth building. Rhys also decides software roadmap and technical release readiness with the operator.
- Whether JNR is ready to seek certification. Only a certification body can award accredited certification after auditing JNR; this pack cannot do that.
