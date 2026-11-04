# JNR QMS 014: Identification and traceability

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Identification and traceability |
| Reference | JNR QMS 014 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Keep each part, batch and material identifiable from receipt to delivery, so a suspect part can be traced. Raw material, cut pieces, work in progress, finished parts, splits, remakes and outside work. Labelling method: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (production control and traceability) and #342 (traceability row). Material and job fields are Tolra facts.

## Responsibilities

- Workshop lead: labels and batch splits. NEEDS CONFIRMATION.
- Office: keeps the Tolra job and material links correct. NEEDS CONFIRMATION.
- Inspector: checks the labels and the certificate match the part.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Match each material delivery to its certificate and its heat, cast or batch number. Check the certificate against the order.
2. Label stock, cut pieces, work in progress and finished parts as required. Keep the identity through splits, remakes and outside work. NEEDS CONFIRMATION for the label format.
3. Record the material certificate and heat or cast number in Tolra on each traceable job. Inspect the physical label and the certificate as well; the Tolra fields alone are not proof of the physical batch.
4. Where a batch is split, record which parts came from which batch and where each batch is kept. NEEDS CONFIRMATION.
5. Check the identity before despatch: job, part, batch, certificate and quantity agree.

## Tolra support and its limits

- Material certificate and heat or cast fields on the job worksheet: [lib/job-worksheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-worksheet.ts). Certificate pack on a job: [components/cert-pack.tsx](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/components/cert-pack.tsx).
- Job numbers allocated on order conversion: [migration 018](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/018_atomic_order_conversion.sql).
- Limit: Tolra does not verify a certificate or a physical batch, and does not prove physical labels or lot splits. Codex #342 lists these as gaps.

## Records

- Certificate and heat or cast record per traceable job.
- Batch split and location record (NEEDS CONFIRMATION).
- Label check record.

## Related documents

- JNR QMS 012
- JNR QMS 013
- JNR QMS 015
- JNR QMS 024

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
