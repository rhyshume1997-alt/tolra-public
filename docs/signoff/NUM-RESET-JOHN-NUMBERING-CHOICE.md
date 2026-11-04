# John: keep the document numbers or ask for a new plan?

The current reviewed cutover keeps numbering. Numbers identify real work; they are not a count of rows left after cleaning test data. Deleting test records does not make old numbers safe to reuse.

**Choose one:**

- [ ] **KEEP AND CONTINUE — current supported plan.** Existing issued and imported references stay as they are. Code verifies each next allocation will not collide with an existing/imported/historical reference. Counters never move backwards; an authorised import may need to advance one. Gaps are acceptable evidence, not a reason to renumber. Marpet and other companies keep their own numbers.
- [ ] **REQUEST A RESTART — not approved for execution by this sheet.** Describe the proposed new starting numbers/prefixes below. This holds the affected cutover until the accountant, John, Rhys and technical reviewer agree a separate safe plan and Code proves it on a disposable copy. It does not reset anything, add a new number-setting feature or approve reuse.
- [ ] **NOT DECIDED — keep counters unchanged and hold any step that depends on the choice.**

| Record type | Last issued/imported/historical reference (private report) | Current next allocation | Requested change, only if selected |
| --- | --- | --- | --- |
| Quotes | ____ | ____ | ____ |
| Invoices and related credit notes | ____ | ____ | ____ |
| Purchase orders | ____ | ____ | ____ |
| Jobs | ____ | ____ | ____ |
| Delivery notes and links to invoices | ____ | ____ | ____ |

The existing app can derive job numbers from quotes and delivery-note numbers from invoices. Check those links as well as standalone counters. A customer's own PO reference is theirs; do not replace it with a Tolra number. Do not assume numeric “greater than” alone proves every prefix/link is safe.

Before accepting any restart request:

- [ ] Accountant confirms audit/VAT references and existing exports remain traceable.
- [ ] No customer or supplier can receive two different documents with the same identity.
- [ ] Original PDFs, linked jobs/payments/chase approvals/history and source references remain unchanged.
- [ ] A complete cross-company/duplicate/link check and independently checked next-number sample exist. No live allocation is made merely to test this form.

For the current plan, “keep” permits only the already reviewed safe continuation checks, not arbitrary counter edits. “Restart” is a request for a separately reviewed decision, not permission for SQL. Never reset numbering to get a wipe/import to pass. No production action was performed here.

Choice/reason and private evidence/version: ____.

John name/signature/date: ____  Accountant consulted/name/date: ____

Rhys/reviewer decision on any requested change: ____  Signatures/date: ____

Blank master, prepared 4 November 2026. Fill and sign a private copy. An empty box is not approval. Keep phone numbers, customer records, keys and signatures out of the public repository.
