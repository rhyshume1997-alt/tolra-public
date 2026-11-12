# JNR QMS 013: Production and job control

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Production and job control |
| Reference | JNR QMS 013 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Make the right part, with the right instructions, checked at the right points, and keep the record of what was done. Every job from start to finish in the workshop, including setup, CNC program use, in-process checks and outside work. Exceptions: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (production control and traceability, clause 8.5).

## Responsibilities

- Workshop lead: NEEDS CONFIRMATION for appointment.
- Operators: follow the job instructions and record their work.
- Authorised inspector: records the checks (JNR QMS 015).

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Before starting, check the job number, the approved drawing revision, the CNC program and setup revision, quantity, material and the required checks. Check the operator's competence, machine readiness and gauge status. Stop if anything is unclear.
2. Follow the approved setup and in-process checks. Record the work and time against the right job. Keep queued or offline entries until they are saved; do not enter them twice.
3. Keep measurements for the checks that cannot be fully checked afterwards, including any special process (for example welding) that needs a qualification record. NEEDS CONFIRMATION.
4. Put suspect output on hold and follow JNR QMS 017.
5. Any production change is reviewed and authorised before use (JNR QMS 025).
6. Operator sign-off on a job is recorded in Tolra against the worksheet revision it signed. NEEDS CONFIRMATION for whether JNR uses it.

## Tolra support and its limits

- Job worksheet and drawings: [lib/job-worksheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-worksheet.ts); jobs: [jobs page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/jobs/page.tsx).
- Operator sign-off against the worksheet revision: [lib/job-signoff.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-signoff.ts) (migration [045](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/045_job_signoff.sql)).
- Time sheets: [lib/time-sheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/time-sheet.ts).
- Problem flag on a job: [lib/job-problems.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-problems.ts) (migration [117](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/117_job_problems.sql)). A Problem flag does not stop Start, Pause or Finish.
- Limit: CNC program control, setup sheets and physical checks are outside Tolra (Codex #342).

## Records

- Job record with worksheet revision.
- Operator sign-off.
- Time records.
- In-process and special-process records (NEEDS CONFIRMATION).

## Related documents

- JNR QMS 014
- JNR QMS 015
- JNR QMS 016
- JNR QMS 017
- JNR QMS 023 maintenance register

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
