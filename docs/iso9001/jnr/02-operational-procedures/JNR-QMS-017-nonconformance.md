# JNR QMS 017: Nonconforming work and its control

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Nonconforming work and its control |
| Reference | JNR QMS 017 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Stop suspect or wrong work from being used or sent, decide what to do with it, and keep a numbered record. Any part, material, batch or service that does not meet its requirement, found at any stage, including after delivery. Numbering: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (wrong output and corrective action, clauses 8.7 and 10.2). Tolra facts from the problem and inspection code.

## Responsibilities

- Person who finds the problem: stops use, labels the part and reports it.
- John or named quality lead: decides the disposition and who may do so. NEEDS CONFIRMATION.
- Customer contact: NEEDS CONFIRMATION.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Stop use and despatch of the affected parts. Label and separate them. Note the job, batch, quantity, location and the requirement that failed.
2. Check whether other jobs, stock or delivered parts may be affected. Tell the right people, and the customer where needed. NEEDS CONFIRMATION.
3. Open a numbered nonconformance record outside Tolra and link it to the job, problem flag or inspection. NEEDS CONFIRMATION for the numbering scheme.
4. An authorised person decides: rework, scrap, return or concession. Record the decision, the person and the date. Get any required customer approval before release. A typed reason in Tolra is not customer agreement.
5. After rework, check the part again against the requirement and record the result.
6. Decide whether corrective action is needed (JNR QMS 018). Record the reason if it is not, too.

## Tolra support and its limits

- Problem flag on a job: [lib/job-problems.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-problems.ts) (migration [117](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/117_job_problems.sql)). Raising it needs a connection. Clearing it needs admin or office with a note. It does not stop Start, Pause or Finish.
- Inspection failures and dispositions: [lib/inspection.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/inspection.ts).
- Limit: Clearing a Problem flag is not closure of a nonconformance or corrective action.

## Records

- Nonconformance record with number, facts, containment, disposition, authority and customer approval (NEEDS CONFIRMATION).
- Recheck record.

## Related documents

- JNR QMS 013
- JNR QMS 015
- JNR QMS 018 corrective action
- JNR QMS 019 complaints

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
