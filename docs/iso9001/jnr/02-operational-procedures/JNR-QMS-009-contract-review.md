# JNR QMS 009: Customer order and contract review

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Customer order and contract review |
| Reference | JNR QMS 009 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Agree the right work with the customer before JNR promises it. Every new order, quote acceptance, drawing or specification change, and verbal or email request that JNR accepts. Thresholds and exceptions: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #339 (I4 customer order and contract review, clause 8.2).

## Responsibilities

- John or named order reviewer: NEEDS CONFIRMATION.
- Office: records the review and links it to the quote, order and job.
- Workshop lead: confirms capacity and machine readiness.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Save the enquiry, drawing or specification with its revision, quantities, materials, tolerances, finishes, due date, delivery and certificate needs. Ask about traceability, inspection, customer property and legal needs.
2. Check that JNR can do the work: capacity, machines, competence, gauges, special processes and outside services. Resolve gaps or conflicts with the customer before accepting. Write down and confirm any verbal request.
3. Compare the customer order with the quote. Record each difference and the agreed answer. A quote marked accepted is not, by itself, a full review.
4. Create or link the quote, order and job in Tolra where enabled. Check that the job number and drawing revision reach the workshop. Where Tolra is not used for a step, use the approved manual record. NEEDS CONFIRMATION.
5. For a change, stop affected work if instructions are unclear. Review its effect on parts already made, material, cost, delivery and outside work. Get the customer's agreement, record the new revision and tell affected people. NEEDS CONFIRMATION.
6. Record who reviewed the order, the date, the decision and the evidence of customer agreement. NEEDS CONFIRMATION for the form used.

## Tolra support and its limits

- Quotes and quote versions: [quotes page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/quotes/page.tsx) and [lib/quote-versions.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/quote-versions.ts).
- Sales orders and conversion to jobs: [sales orders page](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/%28dashboard%29/sales-orders/page.tsx); [lib/sales-order-convert.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/sales-order-convert.ts).
- Customer's own PO reference, shown on quote, job, delivery note and invoice: [lib/customer-po.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/customer-po.ts) (migration [123](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/123_quote_customer_po.sql)).
- Limit: Tolra stores the review data you enter. It does not record JNR's review decision or the customer's agreement.

## Records

- Order review record with reviewer, date, decision and customer agreement (NEEDS CONFIRMATION).
- Quote, order and job references.
- Changed-instruction issue record.

## Related documents

- JNR QMS 010 design applicability
- JNR QMS 013 production and job control
- JNR QMS 019 complaints
- JNR QMS 025 change control

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
