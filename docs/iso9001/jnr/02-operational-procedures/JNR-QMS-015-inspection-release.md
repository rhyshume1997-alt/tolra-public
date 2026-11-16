# JNR QMS 015: Inspection and release of work

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Inspection and release of work |
| Reference | JNR QMS 015 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Check that work meets its requirements before it is released, and record who released it and on what evidence. Inspection at every point JNR sets, and the final release before despatch. Inspection plan and points: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #341 (first internal audit checklist, clause 8.6 row) and #342 (inspection row). Tolra facts from the inspection code.

## Responsibilities

- Authorised inspector: records the inspection. Only a person on the authorised inspectors list may record a pass or co-sign as the inspector.
- John: sets who may release work, and whether any early release is allowed. NEEDS CONFIRMATION.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Set the inspection points for each job type (first-off, in-process, final). NEEDS CONFIRMATION.
2. Check the part against the approved drawing revision and the stated criteria. Record the measurements and the result.
3. Only an authorised inspector records a pass. Record the inspector's name and the date.
4. A failed check goes to JNR QMS 017. Do not release the part until the disposition is recorded.
5. Release: record who released the work, the evidence used, and that the criteria were met. Early release, if allowed, must have a recorded reason and the authority of the person releasing. NEEDS CONFIRMATION.
6. Check any customer approval needed before release. NEEDS CONFIRMATION.

## Tolra support and its limits

- Inspection records and their outcome: [lib/inspection.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/inspection.ts). The delivery note may say that the work was inspected or checked, with the inspector's name and date, but not the criteria or measurements (same file).
- Authorised inspectors list and its history: [lib/inspectors.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/inspectors.ts) (migration [083](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/083_authorised_inspectors.sql)).
- Limit: Tolra does not manage gauge identity, calibration or bad-gauge impact (JNR QMS 016). Tolra allows some admin early releases; JNR must control that permission (Codex #339).
- Inspection pages depend on the database features being installed. Whether JNR's installed release has them is NEEDS CONFIRMATION.

## Records

- Inspection record with criteria, measurements, result, inspector and date.
- Release record with authority.
- Customer approval where needed (NEEDS CONFIRMATION).

## Related documents

- JNR QMS 013
- JNR QMS 016 calibration register
- JNR QMS 017
- JNR QMS 024

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
