# JNR QMS 011: Supplier approval and review

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Supplier approval and review |
| Reference | JNR QMS 011 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Make sure each supplier and outside process is suitable before JNR uses it, and keep the evidence. Material suppliers, subcontract machining, welding, heat treatment, coating, calibration and any other outside process. List: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (purchasing and supplier control, clause 8.4) and #342 (supplier status row).

## Responsibilities

- John: approves suppliers and their scope. NEEDS CONFIRMATION.
- Purchasing lead: keeps the evaluation log. NEEDS CONFIRMATION.
- Admin: changes the Tolra supplier status only when John has approved it.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. List each supplier and the work it may provide. Set the checks based on how a bad supply could affect the finished part.
2. Before first use, assess ability with evidence: capability, sample, past results, certificates or a visit. Record the approver, scope, conditions and next review date. NEEDS CONFIRMATION for the criteria.
3. Link the external evaluation record to the Tolra supplier entry. Tolra status Approved, Conditional or Blocked is set by an admin. Conditional gives a warning when a purchase order is issued; Blocked stops a purchase order being issued. A default Approved status is not an evaluation.
4. Check supplier identity on each purchase order. A supplier name typed as free text has no status warning, so it does not bypass JNR's review.
5. Review performance at the agreed date and after any serious issue. Decide to retain, restrict or block, and tell affected staff. Reassess before lifting a block. NEEDS CONFIRMATION for the review period.

## Tolra support and its limits

- Supplier status rules: [lib/supplier-status.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/supplier-status.ts) (migration [082](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/082_traceability_records_suppliers.sql)).
- Suppliers and purchase orders: [suppliers page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/suppliers/page.tsx); [purchase orders page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/purchase-orders/page.tsx).
- Limit: Codex #342 found that the scope, evidence, review date and performance workflow are not in Tolra. Status is a flag, not an assessment.

## Records

- Supplier evaluation record and approval (NEEDS CONFIRMATION).
- Supplier scope list.
- Performance review record.

## Related documents

- JNR QMS 012 purchasing
- JNR QMS 014 identification and traceability
- JNR QMS 018 corrective action

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
