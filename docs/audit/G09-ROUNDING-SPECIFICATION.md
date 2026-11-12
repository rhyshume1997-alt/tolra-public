# G09 — Versioned rounding specification

Version 0.1 draft | Prepared 4 November 2026 | Owner ____ | Approved issue/effective date ____.

**NOT EXECUTED.** Blank fields are not results or consent. Complete records privately after the work; no real data belongs in this public template. Tolra supports JNR’s quality work; JNR is audited, and these documents cannot certify it.

## Proposed rule — Rhys must approve

Scope: ordinary invoices, quotes, payments, VAT, displays and source-to-destination reconciliation. **Costing calculations, rates and costing golden answers are excluded**; do not change their separate rules through this document.

1. Use exact decimal inputs and whole pennies for money. Round to the nearest penny; a positive half-penny goes up: £0.125 → £0.13, £0.135 → £0.14, £1.005 → £1.01. Do not use a floating-point approximation or round to an even last digit.
2. For negative values, round the magnitude the same way and restore the sign: −£0.135 → −£0.14. This is the existing “half away from zero” rule; “halves up” does not mean move negative ties towards zero.
3. For each priced line, multiply quantity by unit price, round that net line to pennies, then calculate and round that line’s VAT to pennies. Add rounded line nets and VAT to form document totals. Use the applicable rate/exemption; do not replace per-line VAT with VAT calculated on the summed net. Retain authorised stated VAT adjustments and their evidence.
4. Payments and reversals must keep the evidenced amount and correct invoice link. Use whole-penny arithmetic for paid totals and balances. Do not silently round or alter a SliQ/source figure to hide a mismatch; investigate unsupported precision or differences.
5. Screens, PDFs and exports show the same stored/checked penny amount, normally to two decimal places. Formatting must not change money. Reconciliation compares counts and integer pennies per record and in total; explain every difference, including credits, reversals and exclusions.

## Evidence and adoption record

Requirement ID: G09-ROUND-____; version being assessed ____; exact final checkout SHA ____; scope/exceptions reviewed ____.

Expected result: app/database/display/export agree with this approved rule for all in-scope cases; costing remains separate. Actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval **Rhys decision ____; signature ____; date ____**.

Existing references, not a fresh result: [38 tie cases](https://github.com/rhyshume1997-alt/tolra-public/blob/8021d1144201b0a9a401631902a1f17ccaa1657e/tests/db/money-parity-ties.test.ts); [money-parity run 41904817337](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41904817337), head `8021d1144201b0a9a401631902a1f17ccaa1657e`. That run does not approve a different final SHA or replace Rhys’s signature.

Builder 5: document-only template. No test, load, restore, production SQL, merge or message to John performed. Source/whitespace review only; operational results and approvals remain NOT EXECUTED/blank.
