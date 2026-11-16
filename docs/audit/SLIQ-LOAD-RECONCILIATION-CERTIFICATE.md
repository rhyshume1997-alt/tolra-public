# SliQ load — Source-to-destination reconciliation certificate

Version 0.1 draft | Prepared 4 November 2026 | Owner ____ | Approved issue/effective date ____.

**NOT EXECUTED.** Blank fields are not results or consent. Complete records privately after the work; no real data belongs in this public template. Tolra supports JNR’s quality work; JNR is audited, and these documents cannot certify it.

This blank certificate is not acceptance of a load. Final checkout SHA ____; source snapshot/export time ____; source file hashes ____; target identity ____; import batch/operation IDs ____; mapping/preprocessor version ____; source cutover/freeze time ____.

## Copy one complete record for each file and each money check

Requirement ID: SLIQ-REC-____; file/report/period or invoice reference ____; agreed source population/filter ____; measure (record count / net / VAT / gross / payment / credit / balance) ____.

Source count or amount (integer pennies) ____; destination count or amount ____; approved excluded/held count or amount ____; expected difference and reason ____; actual difference ____ — **NOT EXECUTED**.

**Expected result:** every source record is accounted for once as included or explicitly excluded/held; destination links and amounts match the agreed source to the penny; no unexplained difference or duplicate remains.

Actual result ____ — **NOT EXECUTED**; evidence reference (source/destination comparison and hashes) ____; tester ____; date ____; approval ____.

## Required coverage — assign a record above to every item

| Requirement ID prefix | Check |
| --- | --- |
| SLIQ-REC-FILE | Counts for each source file: input rows, title/header/blank/group/totals rows, real records, included and excluded/held. Report furniture never counts as business records. |
| SLIQ-REC-INV | Each invoice and overall net, VAT and gross totals; correct customer, date and original reference. |
| SLIQ-REC-PAY | Every payment maps to its intended invoice, with correct amount/date and count; duplicates and reversals are accounted for. |
| SLIQ-REC-CRD | Every credit note has correct sign/amount and approved invoice link or an explicit held/excluded record; it is not silently treated as cash. |
| SLIQ-REC-BAL | Per-invoice and overall balances match the source after verified payments, reversals and applicable credits; no double counting. Explain unknown payment status. |
| SLIQ-REC-EXCL | Exclusions register covers affected references, quantities/money, reasons, retrieval route and owner approval; totals reconcile included plus excluded/held records. |

Use fixed original exports; do not alter source amounts or expected values to force agreement. Missing source/detail is a deviation, not a zero. An aggregate match alone does not prove invoice/payment links.

Independent checker (not the loader) ____; comparison evidence reference ____; discrepancies/action owner/due ____; recheck record IDs ____; final decision ____ — **NOT EXECUTED**; checker signature/date ____; authorised sign-off/name/date ____.

Builder 5: document-only template. No test, load, restore, production SQL, merge or message to John performed. Source/whitespace review only; operational results and approvals remain NOT EXECUTED/blank.
