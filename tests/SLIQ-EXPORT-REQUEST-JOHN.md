# John: SliQ files we need — G9 / C6

Send original CSVs or the Excel workbook with every tab **privately to Rhys and Code**. Keep headings, amounts, account/document numbers, zeros and prefixes unchanged.

**Two sets:** practice exports by Fri 6 Nov; fresh complete exports after John/Rhys agree the final entry cut-off and paper-work plan. Label each set with JNR company, export time, date range, filters and totals. Keep originals.

These are working file names and column meanings; **real SliQ headings remain unconfirmed**. Send all original columns. The companion gives exact current code headings and one fake row per file; never enter examples as real data.

| Please include this file/report | Columns we need to identify/check |
| --- | --- |
| customers.csv | Account code, company/name, contact, address/postcode, email, phone, VAT number, notes |
| suppliers.csv | Supplier account code, name, contact, address/postcode, email, phone, VAT number, notes |
| products.csv | Item code, description, unit price, stock, VAT rate |
| invoices.csv | Invoice number/type, account, invoice/due date, net, VAT, gross, status, amount paid, related invoice, VAT code, discount, notes |
| quotes.csv | Quote number, account, date/valid-until, net, VAT, gross, status, discount, notes |
| invoice-lines.csv (or document-lines.csv) | Document number, description, quantity, unit price, line net/VAT, VAT rate/code, discount |
| payments.csv | Invoice number, received date, amount, method, payment reference |
| credit-notes.csv | Credit number, account, date, net/VAT/gross, original invoice, reason, notes |
| allocations.csv | Credit number, invoice number, amount used, date |
| purchase-orders.csv | Order number, supplier, order/delivery date, total and whether net/gross, status |
| opening-balances.csv | Account, customer/supplier type, document, date, opening amount |
| supplier-bills.csv | Bill number, supplier, date, net/VAT/gross, amount still owed |
| refunds.csv | Original invoice, date, amount, method, reference |
| sales-orders.csv | Order number, account, order/delivery date, total, status, quote, customer order |
| jobs.csv | Job/account/order, stage/status, ordered/made/accepted/rejected/reworked/sent/remaining quantities, value, due date |
| deliveries.csv | Delivery number/date, job, order, invoice, quantity |

If a report is unavailable, say which; send its original PDF or headings privately. Do not guess. Include next quote/invoice/order/job numbers and accounts’ work-in-progress cost report; selling price is not cost. Prove any genuinely empty report with its filters.

**Stop:** missing files, lost zeros, wrong totals, unclear identities or cut-off mean no final import. The last six files are comparison-only; credits/allocations still need real header mapping. Code resolves gaps/held rows and compares results before separate import authority.

Exact current headings and one made-up row for **each of the sixteen files**: [SLIQ-EXPORT-EXAMPLES.md](SLIQ-EXPORT-EXAMPLES.md). Keep the examples beside this one-page handout. No exports or results have yet been accepted.
