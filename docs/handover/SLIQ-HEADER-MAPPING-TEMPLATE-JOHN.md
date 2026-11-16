# G9 / C6 — John’s SliQ header-mapping template

Draft / Builder 6 L10 / 4 November 2026. **John fills the real headings; Code confirms what each means.** This is the missing-information form, not a confirmed import profile or import permission. Keep a filled copy and original real files **privately**, outside Git. Never replace original headings with the examples from #320 or enter made-up rows as real data.

## Start here, John

1. Export the original CSVs or workbook with every tab/column, unchanged. Keep account/document codes as text with zeros/prefixes. Do not open and resave through a spreadsheet if it might change them.
2. For each of the sixteen reports below, copy the EXACT printed column heading into “Actual heading”. If one meaning spans columns, list all headers and their order. Put private sample-row references in the next column; no real names or amounts go in the public repo.
3. If absent, write **NOT EXPORTED** and why; if genuinely empty, write **EMPTY**, date/filter proof and the control total. Missing is not zero. Do not guess. If a different report supplies the value, name it and its stable join key.
4. Send the originals and this private form to Rhys/Code by the agreed secure route. Code checks parser mapping/date/encoding, resolves every ambiguity/held row and saves the real no-write report. John checks meanings/totals; accountant signs WIP COST. A completed form alone does not unblock final transfer.

Practice exports due Friday 6 November; a NEW complete final set follows the agreed source-entry cut-off for Thursday 12 November. Final headers/filters/mapping/file hashes must be checked again. Never reuse the practice numbers as final totals.

| Whole export set — John fills | Private entry |
| --- | --- |
| Company / SliQ version / exported by / date and time zone | ____ |
| Practice or final / source entry cut-off / date range and filters | ____ |
| Folder/workbook original name and private transfer reference | ____ |
| Currency and currency differences / decimal and thousands marks | ____ |
| Date format with an unambiguous example (Code verifies, e.g. day/month/year) | ____ |
| CSV encoding/delimiter/quote character or workbook tab/header-row choices (Code verifies) | ____ |
| Account/document IDs are text with original zeros/prefixes; duplicate/name-match risks | ____ |
| Next quote/invoice/order/job numbers, prefixes and accountant WIP-cost report | ____ |
| Source-to-target mapping revision/hash, real no-write report and reviewer (Code fills later) | ____ |

## Meaning and code keys

The small `code key` is for Code, not a proposed SliQ heading. **Actual heading cells start blank.** “Required” is the existing parser minimum, not permission to omit operational evidence: stable identity, paid amount, VAT/line detail, refunds/credits and full reconciliation still need proof. “Optional” absence needs a documented source/route/scope decision where that value matters. Existing `sliq` profile is provisional; credit/allocations have no real confirmed map and extra reports have no confirmed SliQ reconcile map. Do not set `confirmed` because this form is filled.

The first ten types belong to the existing importer mapping; actual writing still needs its confirmed supported route, full dry run and separate authority. The final six are **comparison only**: the existing writer does not automatically create jobs/orders/deliveries or import those report types. Their approved transfer/handling route must be agreed separately, without a new writer in this job.

## 01. customers.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Stable account code (text, including zeros)<br>`customers.key`; `text`; optional parser field | ____ | ____ | ____ |
| Company/customer/supplier name<br>`customers.name`; `text`; required | ____ | ____ | ____ |
| Contact<br>`customers.contact`; `text`; optional parser field | ____ | ____ | ____ |
| Address<br>`customers.address`; `text`; optional parser field | ____ | ____ | ____ |
| Postcode<br>`customers.postcode`; `text`; optional parser field | ____ | ____ | ____ |
| Email<br>`customers.email`; `text`; optional parser field | ____ | ____ | ____ |
| Phone<br>`customers.phone`; `text`; optional parser field | ____ | ____ | ____ |
| Vat number<br>`customers.vatNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Notes<br>`customers.notes`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 02. suppliers.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Stable account code (text, including zeros)<br>`suppliers.key`; `text`; optional parser field | ____ | ____ | ____ |
| Company/customer/supplier name<br>`suppliers.name`; `text`; required | ____ | ____ | ____ |
| Contact<br>`suppliers.contact`; `text`; optional parser field | ____ | ____ | ____ |
| Address<br>`suppliers.address`; `text`; optional parser field | ____ | ____ | ____ |
| Postcode<br>`suppliers.postcode`; `text`; optional parser field | ____ | ____ | ____ |
| Email<br>`suppliers.email`; `text`; optional parser field | ____ | ____ | ____ |
| Phone<br>`suppliers.phone`; `text`; optional parser field | ____ | ____ | ____ |
| Vat number<br>`suppliers.vatNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Notes<br>`suppliers.notes`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 03. products.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Code<br>`products.code`; `text`; required | ____ | ____ | ____ |
| Description<br>`products.description`; `text`; required | ____ | ____ | ____ |
| Unit selling price; say net/gross and discount basis<br>`products.unitPrice`; `money`; optional parser field | ____ | ____ | ____ |
| Stock quantity; distinguish blank (price-list only) from zero<br>`products.stock`; `integer`; optional parser field | ____ | ____ | ____ |
| VAT percentage; say whether 20 or 0.20 means 20%<br>`products.vatRate`; `percent`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 04. invoices.csv — JNR SliQ Invoicing Plus screen and mapping review

**New evidence, 4 November 2026:** Rhys supplied the following observations from his JNR SliQ Invoicing Plus photo through this chat. This records his reported screen labels/values; the photo/export was not independently inspected here. These are **observed screen columns, not confirmed CSV/XLSX export headers**. John still fills the actual-export-heading column below from original files. Keep the filled copy, photo, customer/contact details and real payment examples private.

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

### Invoice-list columns reported by Rhys

| Visible screen label | Observed values / meaning reported | Mapping implication / still to confirm |
| --- | --- | --- |
| Type | Invoice or Credit Note | Candidate `invoices.docType`; existing word map recognises both, but the current provisional invoice column map omits this field. Confirm actual export header/type words and credit sign/original-invoice link. |
| Num | Examples INV-2283 to INV-2315 | Candidate `invoices.number`; preserve the full text prefix/digits. Provisional map expects `Number`, not confirmed `Num`. This visible range is not proof of complete history or the next unused number. |
| Date | dd/mm/yyyy on screen | Candidate `invoices.date`; provisional map expects `Invoice Date`. Confirm actual export date/header/cell type separately; screen formatting alone does not establish it. |
| Customer | Customer shown | Candidate `invoices.customer`; obtain stable account code and customers-file join. A display name alone cannot resolve duplicates safely. |
| Total | Amount shown | Potential `invoices.gross` ONLY if confirmed VAT-inclusive; net/gross/VAT basis unknown. Parser requires separate net, VAT and gross; never invent the missing amounts. |
| Paid | No / Yes / Overdue | A display status, **not a numeric paid amount**. No/Yes are absent from the provisional invoice status-word map; Overdue maps to issued/sent there, not a payment. Confirm lifecycle and partial-payment semantics before any status mapping. |
| Sent | Tick | Separate sending indicator; no `invoices.sent`/sent-tick canonical key. Do not confuse this tick with Paid or proof of recipient receipt. Writer currently sets legacy invoice `sent_date` to null. |
| Notes | Notes | Candidate `invoices.notes`, but provisional map omits it; parsing notes does not establish their preservation in the invoice writer (see gaps below). |
| Month Raised | Month Raised | No invoice canonical key; ask whether a derived report grouping or distinct accounting period. Do not substitute it for invoice Date. |
| Due Date | Due Date | Candidate `invoices.dueDate`; that header is in the provisional profile, but the real export and blanks/default rules remain unconfirmed. |
| Order | Customer PO | No invoice canonical customer-PO field in this mapping. This is the customer's order reference, not automatically a Tolra purchase order or sales-order ID. Preserve source and agree a reviewed route. |
| Quote | QUO-nnnn | No invoice canonical quote-link key. Preserve exact text and confirm the quote-file join. **Do not map a quote number to `invoices.relatedInvoice`.** |

### Detail pane reported by Rhys

| Visible detail | How it helps / mapping gap |
| --- | --- |
| Invoice No | Compare with list Num and each exported parent reference; confirm Credit Note detail/numbering too. |
| Outstanding | Balance-comparison evidence; no `invoices.outstanding` key. Do not infer cash paid as Total minus Outstanding without reconciling VAT basis, credits, allocations, refunds and payment records. |
| Age | No canonical invoice-age key; ask what date/period drives it. Do not treat age as another date or paid amount. |
| Contact / Email | Customer/contact evidence; corresponding customer-file contact/email fields exist. Confirm stable customer identity, whether invoice-specific overrides exist and how they export; not direct invoice-header fields. |
| Related Quote | Quote relationship, not the original invoice for a credit note. No canonical invoice quote-link field; confirm exported join and preservation route. |
| Tel / Mobile / Fax | Confirm separate export fields and whether customer-level or invoice-specific. Customer canonical `phone` exists; separate mobile/fax keys do not. Do not silently collapse/discard distinct numbers. |
| Payments list: Amount, Date, Kind, Info | Candidates for `payments.amount`, `.date`, `.method`, `.reference`; exact meaning/header mapping and parent `payments.invoiceNumber` still require proof. In particular Kind is not assumed to match current method words, and Info is not assumed to be only a payment reference. |

### Questions John must answer before invoice mapping can be confirmed

| Question for John — supply original export/private example, do not guess | John's answer / private evidence / Code check |
| --- | --- |
| Is Total VAT-inclusive on this screen and in the export? Where are net, VAT amount, VAT code/rate, discounts and invoice lines exported, including zero/exempt/reverse-charge cases? | ____ |
| How are part payments displayed: does Paid stay No, become Yes, show Overdue, or another value? Supply one unpaid, fully paid, part-paid and overdue-with-part-payment example, including total/outstanding and every payment row. | ____ |
| Does Paid Yes mean cash receipt, or can credit allocation/write-off/other adjustment make it Yes? How do refunds, reversals, negative entries and overpayments appear? | ____ |
| What actual export is available (CSV/XLSX/other), with what filenames, tabs, headers, date/cell format, encoding/delimiter, date ranges and filters? Does it include the detail pane and payment rows, or require separate reports? Send originals unchanged. | ____ |
| Where do delivery notes live in SliQ: which menu/report/export? Supply the original report with delivery number/date, invoice/order/job links and line quantities, or mark unavailable with owner/next step. The invoice screen is not delivery-note evidence. | ____ |
| For Credit Note type: what number/sign/status rules apply, where is the ORIGINAL INVOICE reference, and how are credit-to-invoice allocations exported? Is Related Quote only a quote link? | ____ |
| What stable customer account code appears in the export and customers report? Are Contact/Email/Tel/Mobile/Fax invoice-specific overrides or the customer record? | ____ |
| What does Sent tick mean (email, printed/post, marked manually)? Is there an actual sent date or history export? A tick does not prove receipt. | ____ |
| Is Month Raised derived from Date or a different accounting period, and what drives Age? What happens when Due Date is blank or edited? | ____ |
| Does Order export the exact customer PO, and do Quote/Related Quote export the same QUO reference? Which fields/joins preserve them? | ____ |
| In the payments export, which field links each row to Invoice No, what are ALL Kind values and what exactly is Info? Confirm duplicates, repeated amounts/dates, adjustments and amount signs. | ____ |
| Are INV-2283–INV-2315 only the visible/filtered rows? Provide complete agreed history/cut-off/filter totals and actual next-number/prefix evidence rather than assuming INV-2316. | ____ |

### Gaps against the existing importer — not a confirmed profile

Checked at candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`:

- `scripts/sliq-import/mappings/sliq.json` is still `provisional`, `confirmed: false`. Its invoice headers are `Number`, `Customer`, `Invoice Date`, `Due Date`, `Net`, `VAT`, `Gross`, `Status`, `Discount`; the photo's Num/Date/Total/Paid are not confirmed equivalents. Notes, docType, numeric amountPaid and relatedInvoice are canonical fields but are not mapped by that provisional invoice profile.
- `scripts/sliq-import/mapping.mjs` requires invoice number/date/customer/net/VAT/gross/status. The reported screen alone lacks confirmed net/VAT, lifecycle status and stable customer-code evidence. No/Yes cannot be fed into the existing status map unchanged; numeric paid amount must come from reconciled payment evidence, not the Paid label. Date is screen-confirmed dd/mm/yyyy only; actual export date format remains a question.
- `scripts/sliq-import/reconcile.mjs` separates Credit Note type rows (and suspicious negative totals) from ordinary invoices; credits/allocations are not cash. A header Paid flag never substitutes for numeric `amountPaid` and matched payments. Missing evidence stays held/unverified under existing rules; do not force it to paid. Original invoice references and credit allocations remain required; Related Quote is not that relationship.
- `scripts/sliq-import/write.mjs` uses `import_legacy_tenant` plus same-transaction line/payment writes. The invoice legacy payload sets `job_id`, `description`, `sent_date` and `paid_date` to null before its documented follow-up money/date updates; it does not carry the screen's Order/customer PO, Quote/Related Quote, Month Raised, Age or Outstanding as invoice fields. Canonical Notes is used by analysis/review but is not persisted as invoice notes by this writer. Agree preservation/handling for each gap rather than promising screen-complete import.
- Customer/contact and payments files have relevant canonical fields, but actual headers/parent joins/Kind/Info meanings still need John's originals and Code's review. Preserve additional columns and unresolved contact overrides privately instead of inventing unsupported invoice/mobile/fax fields.
- Credit/delivery **RPC** import support tested in L11/#355 is separate from this SliQ CLI: a passing safeupdate proof does not add a credit/delivery CLI writer or establish delivery-note location. Delivery reports remain comparison-only here, and credit/allocations still need actual confirmed mapping and an approved handling route. No new importer functionality/profile flag or data write is made by this update.

### Code's canonical invoice fields — actual export headers still blank

The observations above narrow John's questions; they do not prefill these cells as verified export headers. Code maps only after receiving and checking the originals.

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`invoices.number`; `text`; required | ____ | ____ | ____ |
| Invoice or credit type word<br>`invoices.docType`; `docType`; optional parser field | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`invoices.date`; `date`; required | ____ | ____ | ____ |
| Due date<br>`invoices.dueDate`; `date`; optional parser field | ____ | ____ | ____ |
| Stable customer account link; describe how it matches customers.key<br>`invoices.customer`; `text`; required | ____ | ____ | ____ |
| Net amount excluding VAT<br>`invoices.net`; `money`; required | ____ | ____ | ____ |
| VAT amount<br>`invoices.vat`; `money`; required | ____ | ____ | ____ |
| Gross amount including VAT<br>`invoices.gross`; `money`; required | ____ | ____ | ____ |
| Exact source status word and meaning; not proof of a payment<br>`invoices.status`; `status`; required | ____ | ____ | ____ |
| Amount already paid, separately reconciled to payments/credits<br>`invoices.amountPaid`; `money`; optional parser field | ____ | ____ | ____ |
| Original invoice number/code<br>`invoices.relatedInvoice`; `text`; optional parser field | ____ | ____ | ____ |
| Notes<br>`invoices.notes`; `text`; optional parser field | ____ | ____ | ____ |
| VAT code; include reverse-charge meaning<br>`invoices.vatCode`; `text`; optional parser field | ____ | ____ | ____ |
| Discount; say amount or percent and whether already included<br>`invoices.discount`; `discount`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 05. quotes.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`quotes.number`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`quotes.date`; `date`; optional parser field | ____ | ____ | ____ |
| Stable customer account link; describe how it matches customers.key<br>`quotes.customer`; `text`; required | ____ | ____ | ____ |
| Net amount excluding VAT<br>`quotes.net`; `money`; optional parser field | ____ | ____ | ____ |
| VAT amount<br>`quotes.vat`; `money`; optional parser field | ____ | ____ | ____ |
| Gross amount including VAT<br>`quotes.gross`; `money`; required | ____ | ____ | ____ |
| Exact source status word and meaning; not proof of a payment<br>`quotes.status`; `status`; required | ____ | ____ | ____ |
| Valid until<br>`quotes.validUntil`; `date`; optional parser field | ____ | ____ | ____ |
| Notes<br>`quotes.notes`; `text`; optional parser field | ____ | ____ | ____ |
| Discount; say amount or percent and whether already included<br>`quotes.discount`; `discount`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 06. invoice-lines.csv (or document-lines.csv) — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Parent invoice/document number/code<br>`invoiceLines.documentNumber`; `text`; required | ____ | ____ | ____ |
| Description<br>`invoiceLines.description`; `text`; required | ____ | ____ | ____ |
| Quantity; units and allowed decimals<br>`invoiceLines.quantity`; `quantity`; required | ____ | ____ | ____ |
| Unit selling price; say net/gross and discount basis<br>`invoiceLines.unitPrice`; `money`; required | ____ | ____ | ____ |
| Net amount excluding VAT<br>`invoiceLines.net`; `money`; optional parser field | ____ | ____ | ____ |
| VAT percentage; say whether 20 or 0.20 means 20%<br>`invoiceLines.vatRate`; `percent`; optional parser field | ____ | ____ | ____ |
| Vat amount<br>`invoiceLines.vatAmount`; `money`; optional parser field | ____ | ____ | ____ |
| VAT code; include reverse-charge meaning<br>`invoiceLines.vatCode`; `text`; optional parser field | ____ | ____ | ____ |
| Discount; say amount or percent and whether already included<br>`invoiceLines.discount`; `discount`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 07. payments.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Invoice number/code link<br>`payments.invoiceNumber`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`payments.date`; `date`; required | ____ | ____ | ____ |
| Amount; say sign, currency, major units/pence and meaning<br>`payments.amount`; `money`; required | ____ | ____ | ____ |
| Method<br>`payments.method`; `text`; optional parser field | ____ | ____ | ____ |
| Original payment/refund reference (keep text/zeros)<br>`payments.reference`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 08. credit-notes.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`creditNotes.number`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`creditNotes.date`; `date`; required | ____ | ____ | ____ |
| Stable customer account link; describe how it matches customers.key<br>`creditNotes.customer`; `text`; required | ____ | ____ | ____ |
| Net amount excluding VAT<br>`creditNotes.net`; `money`; required | ____ | ____ | ____ |
| VAT amount<br>`creditNotes.vat`; `money`; required | ____ | ____ | ____ |
| Gross amount including VAT<br>`creditNotes.gross`; `money`; required | ____ | ____ | ____ |
| Original invoice number/code<br>`creditNotes.relatedInvoice`; `text`; optional parser field | ____ | ____ | ____ |
| Reason<br>`creditNotes.reason`; `text`; optional parser field | ____ | ____ | ____ |
| Notes<br>`creditNotes.notes`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 09. allocations.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Credit number/code link<br>`allocations.creditNoteNumber`; `text`; required | ____ | ____ | ____ |
| Invoice number/code link<br>`allocations.invoiceNumber`; `text`; required | ____ | ____ | ____ |
| Amount; say sign, currency, major units/pence and meaning<br>`allocations.amount`; `money`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`allocations.date`; `date`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 10. purchase-orders.csv — existing importer mapping kind

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`purchaseOrders.number`; `text`; required | ____ | ____ | ____ |
| Stable supplier account link; describe how it matches suppliers.key<br>`purchaseOrders.supplier`; `text`; required | ____ | ____ | ____ |
| Order date<br>`purchaseOrders.orderDate`; `date`; optional parser field | ____ | ____ | ____ |
| Delivery date<br>`purchaseOrders.deliveryDate`; `date`; optional parser field | ____ | ____ | ____ |
| Total; say net or gross and whether discounts included<br>`purchaseOrders.total`; `money`; optional parser field | ____ | ____ | ____ |
| Exact source status word and meaning; not proof of a payment<br>`purchaseOrders.status`; `poStatus`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 11. opening-balances.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Stable party/account code<br>`openingBalances.party`; `text`; required | ____ | ____ | ____ |
| Customer or supplier source word<br>`openingBalances.partyType`; `word:partyType`; required | ____ | ____ | ____ |
| Document<br>`openingBalances.document`; `text`; optional parser field | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`openingBalances.date`; `date`; optional parser field | ____ | ____ | ____ |
| Amount; say sign, currency, major units/pence and meaning<br>`openingBalances.amount`; `money`; required | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 12. supplier-bills.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`supplierBills.number`; `text`; required | ____ | ____ | ____ |
| Stable supplier account link; describe how it matches suppliers.key<br>`supplierBills.supplier`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`supplierBills.date`; `date`; optional parser field | ____ | ____ | ____ |
| Net amount excluding VAT<br>`supplierBills.net`; `money`; optional parser field | ____ | ____ | ____ |
| VAT amount<br>`supplierBills.vat`; `money`; optional parser field | ____ | ____ | ____ |
| Gross amount including VAT<br>`supplierBills.gross`; `money`; required | ____ | ____ | ____ |
| Outstanding<br>`supplierBills.outstanding`; `money`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 13. refunds.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Invoice number/code link<br>`refunds.invoiceNumber`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`refunds.date`; `date`; optional parser field | ____ | ____ | ____ |
| Amount; say sign, currency, major units/pence and meaning<br>`refunds.amount`; `money`; required | ____ | ____ | ____ |
| Method<br>`refunds.method`; `text`; optional parser field | ____ | ____ | ____ |
| Original payment/refund reference (keep text/zeros)<br>`refunds.reference`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 14. sales-orders.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`salesOrders.number`; `text`; required | ____ | ____ | ____ |
| Stable customer account link; describe how it matches customers.key<br>`salesOrders.customer`; `text`; required | ____ | ____ | ____ |
| Order date<br>`salesOrders.orderDate`; `date`; optional parser field | ____ | ____ | ____ |
| Delivery date<br>`salesOrders.deliveryDate`; `date`; optional parser field | ____ | ____ | ____ |
| Total; say net or gross and whether discounts included<br>`salesOrders.total`; `money`; optional parser field | ____ | ____ | ____ |
| Exact source status word and meaning; not proof of a payment<br>`salesOrders.status`; `word:salesOrderStatus`; optional parser field | ____ | ____ | ____ |
| Quote number<br>`salesOrders.quoteNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Customer po<br>`salesOrders.customerPo`; `text`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 15. jobs.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`jobs.number`; `text`; required | ____ | ____ | ____ |
| Stable customer account link; describe how it matches customers.key<br>`jobs.customer`; `text`; optional parser field | ____ | ____ | ____ |
| Sales order<br>`jobs.salesOrder`; `text`; optional parser field | ____ | ____ | ____ |
| Stage<br>`jobs.stage`; `word:jobStage`; optional parser field | ____ | ____ | ____ |
| Exact source status word and meaning; not proof of a payment<br>`jobs.status`; `word:jobStatus`; optional parser field | ____ | ____ | ____ |
| Quantity ordered<br>`jobs.qtyOrdered`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity made<br>`jobs.qtyMade`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity accepted<br>`jobs.qtyAccepted`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity rejected<br>`jobs.qtyRejected`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity reworked<br>`jobs.qtyReworked`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity sent/despatched<br>`jobs.qtyDespatched`; `qty`; optional parser field | ____ | ____ | ____ |
| Quantity remaining<br>`jobs.qtyRemaining`; `qty`; optional parser field | ____ | ____ | ____ |
| Job value / selling amount; NOT accountant WIP cost<br>`jobs.value`; `money`; optional parser field | ____ | ____ | ____ |
| Due date<br>`jobs.dueDate`; `date`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## 16. deliveries.csv — comparison only, no automatic import write

Actual original filename/workbook ____; tab ____; header row ____; export/filter time ____; row count ____; source totals/basis ____; file hash (Code) ____; [ ] Supplied [ ] Empty with proof [ ] Not exported (reason/owner ____).

| Meaning / code key / parser type and minimum | Actual SliQ heading(s), exactly copied — John | Private sample row(s) / format or join explanation | Code checked mapping / unresolved issue |
| --- | --- | --- | --- |
| Document number/code (text, including prefixes and zeros)<br>`deliveries.number`; `text`; required | ____ | ____ | ____ |
| Document/received/transaction date as this report defines it<br>`deliveries.date`; `date`; optional parser field | ____ | ____ | ____ |
| Job number<br>`deliveries.jobNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Sales order number<br>`deliveries.salesOrderNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Invoice number/code link<br>`deliveries.invoiceNumber`; `text`; optional parser field | ____ | ____ | ____ |
| Quantity; units and allowed decimals<br>`deliveries.quantity`; `qty`; optional parser field | ____ | ____ | ____ |

Other original columns/meaning (do not discard) ____; missing-field source/report/join/approved handling ____; John meaning checked ____ date ____; Code issue owner/review date ____; [ ] Ready for mapping review [ ] Gap remains.

## Source words, dates, signs and relationships — complete before a mapping is confirmed

| John writes the exact source word/rule | Code records the supported target meaning/handling | Evidence / unresolved owner |
| --- | --- | --- |
| Invoice status words (all of them) ____ | Draft/issued/void etc.; “Paid” word alone must not invent money ____ | ____ |
| Invoice versus credit-note words ____ | Exact document kind and related-document handling ____ | ____ |
| Quote and purchase-order statuses ____ | Supported status map; unknown stays held ____ | ____ |
| Customer/supplier opening-balance type words ____ | Correct party type and signed balance basis ____ | ____ |
| Job stages/statuses and sales-order statuses ____ | Separate comparison mapping words; no writer promise ____ | ____ |
| Payment-method words; reversals/refunds/negative amounts ____ | Distinct payment/refund/credit treatment; no double netting ____ | ____ |
| VAT codes, percentages and reverse-charge words ____ | Exact VAT meaning; distinguish zero/exempt/unknown ____ | ____ |
| Discount units and line/document basis ____ | Amount/percent, included or additional; no double discount ____ | ____ |
| Purchase-order total basis ____ | Net or gross; evidence for VAT comparison ____ | ____ |
| Blank versus zero versus missing; decimal quantities; stock signs ____ | Explicit parsing rule; never missing-file-as-zero ____ | ____ |
| Dates / money signs / currency / decimal marks / CSV format ____ | Explicit date/encoding/sheet choice; ambiguous rows stay held ____ | ____ |
| Account/invoice/credit/order/job/delivery join keys, case/space/zero rules ____ | Stable identity links; duplicate names never the sole match ____ | ____ |

## WIP, next numbers and the final sign-off gate

John/accountant attach a separate **unfinished-work COST** report: report name/date/filter ____; job key/header ____; cost field/header ____; how valued ____; total ____; private evidence ____; accountant name/signature/date ____. Job selling price is not this cost. Unknown valuation blocks reconciliation.

Next-number/prefix evidence for quotes ____ invoices ____ orders ____ jobs ____; source cut-off ____; imported high-water marks ____; Code's collision comparison ____; John's agreed numbering choice ____. No counter reset is performed by this form.

| Gate — nobody signs an incomplete gate as passed | Blank actual result / signature |
| --- | --- |
| John confirms sixteen report statuses, real headings/meanings, source cut-off/filters and original files | ____ signature/date ____ |
| Code verifies exact canonical keys/header resolution, ambiguity/duplicate rules, text IDs/zeros, dates/encoding/sheets, status/sign/discount/VAT rules and unsupported-field routes against the originals | ____ mapping revision/hash/report ____ signature/date ____ |
| Every missing/empty/held/unsupported item has evidence, owner and approved route or explicitly reviewed scope; no name-only match, missing-as-zero or fake profile result | ____ gap ledger ____ reviewer/date ____ |
| Actual existing importer no-write report plus complete comparison against John's actual export set, with pence/payments/credits/refunds/jobs/WIP/next numbers reconciled | ____ report ____ John/Code/accountant ____ |
| Practice accepted; fresh final set rechecked without drift | ____ practice date ____ final set/hash/mapping check ____ |
| Separate reviewed import/target/scope authority | ____ authority reference ____ Rhys/reviewer ____ |

Filling the template removes an information gap only after John and Code complete/verify it; final G9/C6 remains blocked until the actual files, mapping, supported handling and full evidence pass. No SQL, import write, profile flag change, message send or production access is performed by this job.

## Sources and L10 handover

Fields/types/required flags are copied from `scripts/sliq-import/mapping.mjs` CANONICAL and `scripts/sliq-reconcile/source.mjs` EXTRA_KINDS at `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`; meanings/report scope follow #320's `tests/SLIQ-EXPORT-REQUEST-JOHN.md` and `SLIQ-EXPORT-EXAMPLES.md`. Fake synthetic headers were deliberately not prefilled as real headings. Original importer ownership stays held.

Builder 6 / atomic claims/L10. Checked sixteen report sections, every current canonical/extra key/type/minimum exactly once, blank actual headings, source-word/sign/identity/date/WIP/next-number gates, comparison-only labels and whitespace. Documentation only; actual John exports, mapping confirmation, runtime/dry-run results, authority and signatures remain open. No new importer scope, main merge, production SQL, deployment or Ready label. John fills privately; original importer owner/Code verifies and reviews next.
