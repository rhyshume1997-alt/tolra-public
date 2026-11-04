# JNR QMS 024: Delivery, despatch and handover

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Delivery, despatch and handover |
| Reference | JNR QMS 024 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Send the right parts, with the right paperwork, to the right customer, and keep proof that they arrived. All goods out: delivery notes, collections, outside deliveries and site handover. Delivery-note numbering and format: NEEDS CONFIRMATION (John's answers, PR #365 questions 1 to 6).

**Source drafts adapted.** Codex #365 (M3 delivery-note UAT and John's six questions, from PR #365 only; not on main) and #361 (delivery evidence row).

## Responsibilities

- John: answers the six delivery-note questions and approves the method. NEEDS CONFIRMATION.
- Office: prepares and checks each note, and sends copies.
- Workshop: confirms the parts are released and labelled.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Check the part is released (JNR QMS 015) and matches the order and the job.
2. Make the delivery note in Tolra from the job, or on the approved manual route where the Tolra route is not agreed. Tolra numbers each note from the company counter, not typed; the numbering rule and first number must be confirmed by John. NEEDS CONFIRMATION.
3. Print, or send the PDF. Check the note against the parts: quantities, units, job, order, address and goods-out wording.
4. Record partial deliveries and returns in the agreed way, so the office knows what is still to go. NEEDS CONFIRMATION.
5. Get the receiver's name, signature and date on the copy. Keep the signed copy. Mark the note signed only after it is signed.
6. If a send is uncertain, keep it held. Do not send a second copy until the first has been checked. NEEDS CONFIRMATION.

## Tolra support and its limits

- Delivery notes page: [delivery notes page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/delivery-notes/page.tsx); print helper [lib/delivery-note-print.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/delivery-note-print.ts).
- Numbering from the company counter, with a typed number refused: [lib/hand-made-delivery-note.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/hand-made-delivery-note.ts). The numbering guard is part of release 147, which is on the overnight release list; whether it is installed at JNR is NEEDS CONFIRMATION.
- Customer sign-off on a job (customer name, signature, and comment): [migration 072](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/072_customer_signoff.sql). Whether JNR uses it is NEEDS CONFIRMATION.
- Status: the delivery-note route for JNR is NOT TESTED for JNR. PR #365 (John's UAT) lists 18 checks and six questions and has not been passed. JNR currently uses handwritten delivery notes. Delivery notes are required for JNR go-live (Thursday 12 November 2026).

## Records

- Delivery note copies with numbers, dates, receiver name, signature and date.
- Partial-delivery and return records.
- Email or send record (NEEDS CONFIRMATION).

## Related documents

- JNR QMS 015
- JNR QMS 014
- JNR QMS 017
- JNR QMS 026 retention schedule

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
