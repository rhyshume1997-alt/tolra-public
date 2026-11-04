# JNR QMS 012: Purchasing and receipt of goods

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Purchasing and receipt of goods |
| Reference | JNR QMS 012 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Buy the right material and outside work from approved suppliers, and check what arrives. Purchase orders for material, outside processes and consumables that affect product. Exceptions: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (purchasing and supplier control, clause 8.4).

## Responsibilities

- Purchasing lead: NEEDS CONFIRMATION.
- Receiver: checks goods on arrival and holds any that look wrong.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Before a purchase order is issued, check the specification and revision, quantity, material, traceability needs, acceptance checks, certificate needs and any customer access or qualification needs.
2. Tell the supplier what evidence must come back with the goods (for example, material certificates with the heat or cast number).
3. On receipt, match the goods to the order, check quantity and condition, and check the required certificate. Record acceptance or rejection and who checked it.
4. Put suspect items on hold, away from usable stock. Record the hold and its release. NEEDS CONFIRMATION.
5. Keep the purchase order and receipt record with the job or stock record. NEEDS CONFIRMATION for how.

## Tolra support and its limits

- Purchase orders and their print pages: [purchase orders page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/purchase-orders/page.tsx); purchase order link [migration 124](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/124_purchase_order_link.sql).
- Material certificate and heat or cast fields: [lib/job-worksheet.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/job-worksheet.ts).
- Limit: Tolra does not record a physical receipt inspection. The receipt check is manual until JNR confirms a method.

## Records

- Purchase order.
- Certificate and receipt record.
- Hold and release record.

## Related documents

- JNR QMS 011 supplier approval
- JNR QMS 014 identification and traceability

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
