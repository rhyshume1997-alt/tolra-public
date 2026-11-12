# SliQ headings and made-up rows — companion to John’s request

Every row below is fake. These are code expectations/examples, **not confirmed real JNR SliQ headings**. John sends original exports unchanged. Code confirms the actual header/date/encoding mapping; the synthetic profile is never a substitute for that work.

The provisional `sliq` profile lists the first eight mapped kinds below; `creditNotes` and `allocations` have empty column maps and need actual headers. Quotes accept `Date` or `Quote Date`; invoice lines accept `invoice-lines.csv` or `document-lines.csv`. Required customer/account identity, amount-paid, VAT and line detail still need mapping even where the provisional profile omits them. Ask for all original columns, not just the parser’s minimum.

## customers.csv

Provisional SliQ mapping.

```csv
Company Name,Contact Name,Email Address,Phone Number,Address,Notes
Trial Engineering,Jo,jo@example.test,00000,1 Test Road,Trial only
```

## suppliers.csv

Provisional SliQ mapping.

```csv
Company Name,Contact Name,Email Address,Phone Number,Address,Notes
Trial Engineering,Jo,jo@example.test,00000,1 Test Road,Trial only
```

## products.csv

Provisional SliQ mapping.

```csv
Item Code,Description,Unit Price,Stock
P001,Trial part,10.00,2
```

## invoices.csv

Provisional SliQ mapping.

```csv
Number,Customer,Invoice Date,Due Date,Net,VAT,Gross,Status,Discount
I001,Trial Engineering,06/11/2026,06/12/2026,10.00,2.00,12.00,Unpaid,0
```

## quotes.csv

Provisional SliQ mapping.

```csv
Number,Customer,Date,Gross,Status,Discount
Q001,Trial Engineering,06/11/2026,12.00,Sent,0
```

## payments.csv

Provisional SliQ mapping.

```csv
Invoice Number,Date,Amount,Method,Reference
I001,06/11/2026,6.00,BACS,PAY001
```

## purchase-orders.csv

Provisional SliQ mapping.

```csv
Number,Supplier,Order Date,Delivery Date,Total
PO001,Trial Steel,06/11/2026,12/11/2026,12.00
```

## invoice-lines.csv

Provisional SliQ mapping.

```csv
Document Number,Description,Quantity,Unit Price,VAT Rate,Discount
I001,Trial part,1,10.00,20,0
```

## credit-notes.csv

Synthetic example only; real SliQ headings NOT CONFIRMED.

```csv
Credit No,Date,Account,Net,VAT,Gross,Against,Reason,Notes
CN-001,10/03/2026,C002,50.00,10.00,60.00,S1002,Goods returned,
```

## allocations.csv

Synthetic example only; real SliQ headings NOT CONFIRMED.

```csv
Credit No,Invoice No,Amount,Date
CN-001,S1002,60.00,12/03/2026
```

## opening-balances.csv

Reconciliation-only synthetic example; no import write support.

```csv
Account,Type,Document,Date,Amount
C002,Customer,S0999,01/03/2026,960.00
```

## supplier-bills.csv

Reconciliation-only synthetic example; no import write support.

```csv
Bill No,Supplier,Date,Net,VAT,Gross,Outstanding
SB-100,SUP2,15/02/2026,200.00,40.00,240.00,240.00
```

## refunds.csv

Reconciliation-only synthetic example; no import write support.

```csv
Invoice No,Date,Amount,Method,Reference
S1006,20/03/2026,30.00,BACS,RF1
```

## sales-orders.csv

Reconciliation-only synthetic example; no import write support.

```csv
Order No,Account,Order Date,Delivery Date,Total,Status,Quote No,Customer PO
SO-0001,C002,03/02/2026,30/04/2026,480.00,In Production,Q2002,PO-C2-77
```

## jobs.csv

Reconciliation-only synthetic example; no import write support.

```csv
Job No,Account,Order No,Stage,Status,Qty Ordered,Qty Made,Qty Accepted,Qty Rejected,Qty Reworked,Qty Despatched,Qty Remaining,Value,Due
J-0001,C002,SO-0001,Machining,In Progress,100,60,50,6,4,40,60,480.00,30/04/2026
```

## deliveries.csv

Reconciliation-only synthetic example; no import write support.

```csv
DN No,Date,Job No,Order No,Invoice No,Qty
DN-0001,10/03/2026,J-0001,SO-0001,,25
```

## What the code actually supports

- `scripts/sliq-import/mappings/sliq.json` is `status: provisional`, `confirmed: false`. It does not map stable party keys, paid amount, invoice type, VAT codes or all optional money fields. Credit notes/allocations have no column definitions. The synthetic mapping demonstrates those fields; it is made-up, not a verified SliQ format.
- `scripts/sliq-import/mapping.mjs` defines ten importer file kinds. Only customers/invoices are parser-required files; that minimum does not make missing operational data safe or complete. `load.mjs` matches headers by name, reads CSV/XLSX, and rejects ambiguous dates/worksheets and numeric spreadsheet identifiers that may have lost zeros. `cli.mjs` refuses write under an unconfirmed profile.
- `scripts/sliq-reconcile/source.mjs` reads the last six extra kinds through a separate `reconcile` mapping. They are not writer features. The current SliQ profile has no such extra mapping. `write.mjs` does not create jobs, sales orders or deliveries; do not promise these will import automatically. Agree a separately reviewed route before final transfer. Refunds are not ordinary positive payments.
- Follow `tests/GO-LIVE-DATA-LOAD.md`: confirm stable identities, pence/paid/credit/refund/job/WIP and next-number evidence, then reviewed dry run and complete comparison. Accountant approves WIP cost. No rounding of imported totals, no name-only matching, no missing-file-as-zero, no write authority from this request.

Sources read at candidate `e7581c43b5f92836ceaedcf2716d495392a9d9e6`: [data-load instructions](https://github.com/rhyshume1997-alt/tolra-public/blob/e7581c43b5f92836ceaedcf2716d495392a9d9e6/tests/GO-LIVE-DATA-LOAD.md), importer `scripts/sliq-import/{mapping,load,cli,write}.mjs`, `mappings/{sliq,synthetic}.json`, reconciliation `scripts/sliq-reconcile/source.mjs` and `tests/fixtures/sliq-reconcile/clean/sliq/*.csv`. No real export, dry-run result or final-import result is claimed.
