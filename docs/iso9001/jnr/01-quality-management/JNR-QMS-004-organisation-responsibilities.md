# JNR QMS 004: Organisation chart and responsibilities

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Organisation chart and responsibilities |
| Reference | JNR QMS 004 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Show who is responsible for each part of the quality system, who can decide, release or stop work, and who covers for them. All JNR staff with a quality, production, inspection, purchasing, order or records role. Names: NEEDS CONFIRMATION. No names are filled in by this draft.

**Source drafts adapted.** Codex #367 (gap M4-02). No separate Codex draft existed. Tolra role facts from lib/company-access.ts and lib/inspectors.ts.

## Responsibilities

- John: approves the chart and each person's authority. NEEDS CONFIRMATION.
- Each named person: keeps to their stated authority and tells John when it changes.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. List each role: quality lead, process owners (order review, production, inspection, purchasing, records, delivery), deputies, and anyone who may stop work. NEEDS CONFIRMATION: names and roles.
2. For each role write what the person may decide (for example release work, approve a supplier, accept a concession, issue a document). NEEDS CONFIRMATION.
3. Match Tolra access to the chart. Admins set company roles; the authorised inspector list is changed only by an admin, with a reason, and each change is kept as history. NEEDS CONFIRMATION for who holds admin rights.
4. Name a deputy for each role. NEEDS CONFIRMATION.
5. Review the chart after any staff change and record the date.

## Tolra support and its limits

- Company roles and access: [lib/company-access.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/company-access.ts) and [admin users page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/admin/users/page.tsx).
- Authorised inspectors: [lib/inspectors.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/inspectors.ts). Each change is a history row (migration [083](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/083_authorised_inspectors.sql)).
- Limit: a Tolra role or tick does not prove a person is competent or authorised. John must justify the access (JNR QMS 020).

## Records

- Organisation chart with names (NEEDS CONFIRMATION).
- Responsibility and authority list, with deputies.
- Access review record.

## Related documents

- JNR QMS 020 training and competence matrix
- JNR QMS 009 contract review
- JNR QMS 015 inspection and release

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
