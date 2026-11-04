# START HERE: JNR Engineering ISO 9001 DRAFT pack

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

## What this is

A first draft pack of 28 quality documents and registers for JNR Engineering, numbered JNR QMS 001 to JNR QMS 028, in five folders that mirror the planned Google Drive layout (01 Quality management to 05 Evidence and approvals). Every document is a DRAFT. JNR's own practice is not known from this pack, so each procedure is a short draft with NEEDS CONFIRMATION prompts where JNR must supply its real steps.

## What is drafted

- 28 documents, each with the full header block: company, title, reference, version and history, owner, prepared by, reviewed by, approved by, effective date, review date, status DRAFT, signature. See [INDEX.md](INDEX.md).
- Each document adapts an existing Codex ISO draft from the public repo rather than duplicating it. Sources are listed in `index.csv`.
- [TOLRA-EVIDENCE-MAP.md](05-evidence-and-approvals/TOLRA-EVIDENCE-MAP.md) lists which Tolra records support each procedure, with built, tested, used, records retained and approved status for each. Only what the repo shows is claimed.
- Two questionnaires, one for Rhys and one for John.

## What was found

- Rhys searched Google Drive and found no existing JNR ISO pack. This build machine cannot reach Google Drive, so the Drive folder layout is mirrored here instead of checked against Drive.
- The public repo `rhyshume1997-alt/tolra-public` holds Codex ISO drafts from PRs #335 to #342, #360, #361, #363 and #367 (all draft PRs, none merged). They are the source for this pack. PR #365 holds John's delivery-note UAT sheet, which is not yet passed.
- Tolra app features were checked at public commit `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. Codex drafts cite the reviewed public main `68f89ca7b801a10587ff9b51d6c820462847b65a`. Both are public code. Neither proves JNR's installed system.
- Tolra covers quotes, orders, jobs and worksheets, operator sign-off, job problem flags, inspection and authorised inspectors, supplier status, purchase orders, delivery notes, invoices, time sheets, admin activity and backup scripts. It does not cover a controlled document approval, a complaint log, a gauge register, a maintenance register, a training matrix, an internal audit programme, management review, or a corrective action log. Those are manual JNR records in this pack.

## What is missing

- JNR's real procedures, owners, deputies and names. Nothing has been filled in for a person.
- Approvals, effective dates, review dates and signatures. All are NEEDS CONFIRMATION.
- The gauge list, supplier evaluations, skills matrix, maintenance list, retention periods and complaint history.
- Real evidence for any Tolra record being used or retained by JNR. None is evidenced in this pack.
- Proof that the backups restore to an isolated database. The scripts exist; a successful restore is not evidenced.
- A passed delivery-note UAT (PR #365). Delivery notes are required for JNR go-live on Thursday 12 November 2026; JNR currently uses handwritten notes.

## What Rhys does first

1. Read this file, then [INDEX.md](INDEX.md) and the evidence map.
2. Check the Drive folder for any JNR paper quality records that John holds, and tell this pack where they are (private location only, never in the public repo).
3. Answer [QUESTIONNAIRE-RHYS.md](QUESTIONNAIRE-RHYS.md). The answers decide which Tolra features are installed at JNR.
4. Take [QUESTIONNAIRE-JOHN.md](QUESTIONNAIRE-JOHN.md) to John, or arrange a short meeting.
5. Decide which of the Codex PR drafts to keep as the basis. None has been merged, and this pack does not merge any of them.

## Questions for John

See [QUESTIONNAIRE-JOHN.md](QUESTIONNAIRE-JOHN.md). It covers the work JNR does, names, gauges, suppliers, records, complaints, delivery notes and training.

## What needs signatures

Every document has blank Reviewed by, Approved by, Signature, Effective date and Review date fields, all marked NEEDS CONFIRMATION.

- John: approves the scope, policy, objectives, owner list, retention periods and each procedure JNR adopts.
- A checker (name to be appointed): reviews each procedure against the real shop.
- Rhys: confirms Tolra technical facts and the installed version. He does not sign for JNR.
- No AI-assisted run fills in any approval, signature or date.

## Honesty note

Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. Nothing here is certification, and nothing here shows that JNR follows any procedure.
