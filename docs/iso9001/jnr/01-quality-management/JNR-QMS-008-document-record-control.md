# JNR QMS 008: Document and record control

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Document and record control |
| Reference | JNR QMS 008 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Make sure each controlled document has one approved master, the right version and an approval record, and that records are kept reliably. Every policy, procedure, form, register, drawing and outside instruction that JNR controls, and the quality records they produce. Storage location, access list and backup: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #336 (I2 document revision and approval procedure, controlled documents register) and #339 (I4 control of records). The 158-path register in #336 is a list of public repo files, not a complete JNR register.

## Responsibilities

- John: approves documents and names an authorised delegate. NEEDS CONFIRMATION.
- Office records lead: keeps the masters, the register and the shop copies. NEEDS CONFIRMATION for the name.
- Writers and checkers: NEEDS CONFIRMATION for names.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Name it: give each document a reference (for example JNR QMS 001), a title, an owner and a storage location. Put it on the document register (JNR QMS 028). A blank form is controlled; a completed form is a record.
2. Write it: the owner writes short steps with the people who use them. Show the version, draft status and the reason for change. Mark example text clearly.
3. Check it: a named competent person checks accuracy, links and usability. Record the reviewer, date and result. Nobody approves their own unreviewed work.
4. Approve it: John or his named delegate approves. Record approver, date and effective date. A Git commit or a draft pull request is not JNR's approval.
5. Issue it: put the approved master in the agreed read-only location. Make a distribution list for shop copies. Tell affected people what changed. Confirm the right revision is at each workstation before work starts.
6. Replace it: move the old master to the restricted archive, mark it Obsolete and remove old shop copies. Keep the change and approval history. Never overwrite a completed record to hide a mistake; add a dated correction with the reason.
7. Review it at the agreed date and after a process, customer, legal or software change, an incident or an audit finding. Version rule proposed for approval: 0.x is a draft; the first approved issue is 1.0; each approved change raises the version. NEEDS CONFIRMATION.
8. Records: keep customer records and private data out of any public repository. Storage, backup, restore, retention and disposal follow JNR QMS 026 and 027. NEEDS CONFIRMATION.

## Tolra support and its limits

- Quote versions: [lib/quote-versions.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/quote-versions.ts). Drawing and worksheet revisions: [lib/job-worksheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-worksheet.ts).
- Issued-document history: [migration 019](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/019_issued_document_history.sql). Audit history: [lib/audit-contract.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/audit-contract.ts) and the admin activity screen [admin/activity](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/admin/activity/page.tsx).
- Gap: Tolra has no general document approval, controlled-copy distribution or obsolete-copy recall workflow (Codex #342). These steps are manual.

## Records

- Document register (JNR QMS 028).
- Approval and change record for each issue.
- Distribution list for shop copies.
- Archive of obsolete masters.

## Related documents

- JNR QMS 025 change control
- JNR QMS 026 retention schedule
- JNR QMS 027 business continuity
- JNR QMS 028 forms and registers index

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
