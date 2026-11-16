# SliQ cutover load — John, Rhys and Code

Draft, 4 November 2026. **No load or reconciliation has been performed by this document.** Code is the separately authorised operator; John owns the source meaning; accounts confirms money; an independent reviewer checks proof; Rhys decides permitted use. This is the reviewed-work sequence, not production SQL/import permission or a new importer implementation.

## 1. Freeze what we actually know

The following are **facts reported by Rhys in the task**, not files inspected here:

| Reported baseline | What to verify on the originals |
| --- | --- |
| Report-style `.xls`, title rows, header on physical row 6, totals row | Actual format, workbook/tab, header row and every excluded title/subtotal/footer row per report |
| Dates `dd/mm/yyyy`; invoice Total includes 20% VAT | Actual date cell values, gross/net/VAT basis, line/tax/discount exceptions and currency |
| 2,035 invoices **plus** two `Crd` credit notes through **13/10/2026** | 2,037 document rows after removing report furniture, split 2,035/2; exact document identities, lifecycle/void/draft scope and credit signs/links |
| 79 customers; suppliers also supplied | 79 source customer rows, distinct stable account identities, duplicates and complete supplier population; do not assume 79 unique or a final November count |
| Payments, quotes, purchase orders, quote items and aged debtors | Each original report, parent joins, date/filter scope, counts and control totals; no counts/money were supplied for these |
| Delivery notes handwritten today and required at go-live | Separate controlled paper source/cut-off and M3 goods-out UAT; do not invent a SliQ delivery export |

**13 October is not the final cutover.** Keep this baseline immutable. Obtain either a complete fresh final set at the agreed Thursday 12 November cut-off, or a separately reviewed baseline-plus-delta plan covering **14 October through the actual cut-off**, including edits/cancellations/payments/credits to older documents. A fresh full set and a delta must never both create the same transactions. Re-run all controls on the final set; do not hard-code 2,037/79 as its expected population.

Private cover: source company/version ____; baseline/final ____; as-of/export time/GMT ____; covered dates/filters ____; source-entry stop owner ____; target JNR/protected Marpet IDs ____; app/converter/mapping/loader revisions and hashes ____; original/normalized/report folder references ____; Code/John/accounts/reviewer/Rhys ____.

**STOP:** unknown target, incomplete cut-off, missing original, mixed baseline/final files or an unapproved data route.

## 2. Preserve and normalize the report files

1. Keep untouched originals read-only in the private evidence folder. Record name, bytes, SHA256, tab/report/filter/as-of date and who exported it. Never publish real records or credentials. Confirm the actual file format from its bytes: `.xls` may be BIFF, HTML or another report format; the extension does not prove it.
2. The inspected SliQ loader supports **CSV and `.xlsx`, not legacy `.xls`**. For workbooks it treats the **first nonblank row as headers**. It does not select row 6 or discard totals automatically. Renaming `.xls` to `.xlsx` does not convert it. A form's “header row” box is not executable parser support.
3. Code uses only a separately reviewed repeatable working-copy conversion. Record tool/version/options; identify the true header (reported row 6) in each tab. Exclude title/blank/subtotal/footer/totals rows by an explicit reviewed rule and retain their control values. Do not remove a transaction because its description resembles “Total”. Preserve every original column and original-row→normalized-row reference; retain extra unmapped fields and unresolved source records privately.
4. Write UTF-8 CSV or an actual supported `.xlsx` with the selected header first. Preserve account/document prefixes/zeros as text. Preserve original date values, decimal signs/currency, partial quantities and credit types. Do not let spreadsheet display formats change stored IDs or dates. Confirm `DD/MM/YYYY` explicitly; ambiguous `01/02/2026` must not be guessed. Distinguish blank, zero, not exported and not applicable.
5. Log input rows = retained data rows + explicitly listed excluded non-data rows. Independently compare row identities/counts/control money before and after conversion. No formula rows, report total or title enters a transaction table. John checks meaning and accounts checks totals. Freeze and hash the normalized files, mapping and transformation ledger together.

**STOP:** conversion not reproducible, unexplained excluded row, lost zero/prefix, ambiguous date, changed penny or unsupported real file. This job supplies no new converter; if none is reviewed/proved, loading remains blocked.

## 3. Match actual headings and supported routes

Use the corrected `SLIQ-HEADER-MAPPING-TEMPLATE-JOHN.md` from M1/#362. Copy actual exported headings; do not substitute old synthetic/provisional examples. The existing `sliq` profile is provisional and its credit/allocation maps are incomplete. A confirmed flag alone is not evidence.

| Source | Required mapping / route check |
| --- | --- |
| Customers and suppliers | Stable account code, name/contact/address/tax fields and document joins. Resolve duplicate names explicitly; names alone cannot establish identity. |
| Invoices | Exact number/type/date/account/net/VAT/gross/status/due date. Numeric paid amounts come from reconciled transactions, not a Yes/No/Overdue label. `Sent` tick does not prove cash or mailbox receipt. |
| Two `Crd` notes | Confirm `Crd` means credit note, sign, original-invoice reference and each allocation/unallocated remainder. Map the actual word explicitly; current Invoice/Credit Note examples do not prove `Crd` support. Import each credit once even if it appears in multiple reports. Never treat it as positive invoice revenue or cash. |
| Payments/refunds/allocations | Parent invoice, date, signed amount, method/reference and stable source identity. Repeated amount/date/reference is an exception to investigate, not automatic evidence of a duplicate or a second receipt. Distinguish reversal, refund, credit allocation, unallocated cash and payment-to-confirm. |
| Quotes and quote items | Header identity/status/amount plus exact parent quote number for each item. The existing shared document-lines kind can feed quote lines after reviewed normalization; `write.mjs` writes `quote_line_items`. A number shared by invoice/credit/quote makes the parent ambiguous and must be resolved. Keep item counts/quantities/totals, not just quote headers. |
| Purchase orders | Header/supplier/date/status/total and whether total is net or gross. Existing writer sets PO `items: []`; complete source PO-item preservation needs a separately reviewed route if such items exist. Do not promise header import carries its lines. |
| Aged debtors | Independent control at a named as-of date, with exact account/invoice and bucket rules. It is not imported as a second set of invoices or payments. Preserve unapplied credit/cash and report filters. |
| Opening balances, supplier bills, refunds, sales orders, jobs and deliveries | Separate comparison-only report kinds in the reconciliation tool; that does not make them writer features. Obtain actual status/evidence and reviewed complete handling where required. No invented zero or delivery export for handwritten work. WIP needs accountant-approved **cost**, not job sale price. |

**VAT:** Total is reported gross, already including 20%; do **not** add another 20%. Obtain the source net/VAT detail and compare `net + VAT = gross` per document and in totals. A fictitious £120.00 gross at standard 20% corresponds to £100.00 net/£20.00 VAT; this illustrates the meaning, not a licence to manufacture missing historic tax splits. If only gross exists, accounts must approve any derived calculation/basis and source proof; do not silently recompute the historical amounts. Resolve zero/exempt/reverse-charge/discount/credit exceptions separately. Controls use exact integer pence and ordinary penny half-up where calculation is needed; the protected costing half-even/60-golden exception is unchanged and irrelevant to copying invoice money.

**STOP:** unresolved kind/sign, orphan item/payment, ambiguous identity, missing financial detail or an unsupported required preservation route.

## 4. Record counts and money BEFORE a write

Create a private control sheet per baseline/practice/final set. John and accounts sign source values; Code/reviewer sign extraction and target comparisons. The original report total is a control, never an imported row.

| Control | Original source | Normalized accepted / held / excluded | Target before | Target after / delta | Difference / evidence |
| --- | --- | --- | --- | --- | --- |
| Ordinary invoice identities/count | Reported baseline 2,035; verified ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| `Crd` identities/count and credit sign | Reported baseline 2; verified ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| All invoice-report data rows | Baseline expected 2,037 if confirmed | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Customer rows / distinct account IDs | Baseline reported 79 / verified ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Suppliers | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Payments / reversals / refunds / allocations, separately | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Quote headers / quote items, separately | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| PO headers / source PO items, separately | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Unpaid collectible invoice IDs / balances | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Aged-debtors accounts / buckets / grand total | ____ | ____ / ____ / ____ | ____ | ____ / ____ | ____ |
| Invoice net / VAT / gross, by lifecycle/type | ____p / ____p / ____p | ____ | ____ | ____ | ____p |
| Credit net / VAT / gross, separately signed | ____p / ____p / ____p | ____ | ____ | ____ | ____p |
| Receipts, reversals, refunds and credit allocations, separately | ____p | ____ | ____ | ____ | ____p |
| Unallocated cash / unallocated credits / opening balances | ____p | ____ | ____ | ____ | ____p |
| Quote line quantities/net/VAT/gross vs headers | ____ | ____ | ____ | ____ | ____ |
| PO totals and net/gross basis | ____ | ____ | ____ | ____ | ____ |
| WIP cost / next numbers including credit/delivery notes | ____ | ____ | ____ | ____ | ____ |
| All protected Marpet/logins/settings/counters/audit/files | Complete before extract/hash ____ | Not transfer scope | ____ | ____ | Must match except approved audited appends ____ |

Account for every source identity exactly once: accepted new + matching existing + explicitly held + independently approved exclusions = source population. A matching existing record is not a new insert. Net target row-count delta may differ from accepted-source count; reconcile the ID map and actual inserts/updates/unchanged records rather than forcing counts. Required unresolved/held rows block the next stage; an exclusion requires named scope/reason and cannot conceal an unpaid debt. Preserve credits/receipts separately: a signed-net total alone can hide lost transactions.

## 5. Real no-write rehearsal, then load only through an approved route

1. Code identifies a separate disposable restore and proves backup/restore, correct version, release prerequisites and protected-company baseline under the existing C16 procedure. Pause agreed writers; do not touch production from this job. Keep automated fake-only suites separate from manual real-data comparison.
2. Run the existing analyser on the **normalized actual private set** with the reviewed mapping/date/encoding options; save `report.md`/`report.json`, exact command/exit, source/mapping/converter hashes and every held/excluded identity privately. If target collision checking was not performed, mark it unproved and complete it on the approved disposable target. `node scripts/cutover-dry-run/cli.mjs` is fixed fake fixtures only and cannot prove this real set.
3. The current SliQ CLI **write path is rehearsal-only**, rejects production/hosted targets and requires a matching disposable identity. Do not create a rehearsal marker on live, disguise a URL/database name, remove a guard or relabel a fake profile to make it pass. The separate credit/delivery RPC proof #355 is not a SliQ CLI writer feature or complete cutover approval.
4. Rehearse the chosen reviewed loader with these exact inputs/mapping on the approved spare target. Include credit/line/payment semantics, safeupdate/atomic failure, retry/no-duplicate and protected-company proof for the actual route. Save complete counts/IDs/money and independent comparison. Do not infer that a generic RPC test imported these real report shapes.
5. **No live load until Code identifies an independently reviewed operational route that can carry the whole approved scope.** Record exact loader revision/input mapping, privileges, transaction/recovery/idempotence boundaries, receipt of complete source proof and separate Rhys/reviewer authority. Missing production-capable route is a blocker, not permission to repurpose the rehearsal CLI. This document intentionally invents no production command.
6. On cutover, recheck final files/deltas/hashes and current target; follow verified **138 → 140 → 141 → 144 → 145 → 146** and the separately approved clearing/loading plan. If clearing already happened, verify actual state; do not repeat it by calendar. The authorised operator runs the approved load once. An uncertain result means HOLD and inspection of actual saved state, not retry. Keep routine app/mail/chase/accounting/import writers fenced through reconciliation and final GO.

## 6. AFTER the load: unpaid invoices and aged debtors must tie

1. Independently extract target records/transactions for JNR only, using the exact as-of date and lifecycle/currency scope of the original reports. Compare all identities/fields, not counts or a sample alone. Attach source-to-target maps and actual route results. Recalculate all controls in section 4, with zero unexplained penny/identity differences.
2. For each issued collectible invoice, reconcile signed transactions in pence: **balance = gross − receipts (net of reversals) − allocated credits + refunds**. Cross-check the source’s own balance and target financial model. Do not also subtract an entire credit-note total when its allocation is already subtracted. Do not assume `gross − outstanding` is cash paid. Draft/void documents, write-offs and other adjustments need explicit reviewed treatment. A payment-to-confirm flag is not a reconciled unpaid or paid result.
3. List every source unpaid invoice by stable account and full invoice number. Match target invoice/customer, gross, receipts, allocated credits/refunds, due date, lifecycle and balance. Match both directions: no missing source debt and no extra target debt. Separately list customer credit and unapplied cash; flooring negative balances at zero can hide them.
4. Align aged debtors’ **as-of date**, transaction inclusion dates, company/currency, draft/void treatment, whether ageing uses invoice/due date, exact bucket boundaries and treatment of unapplied cash/credits. Future payments after that date cannot reduce historical debt. Reproduce each account’s current/age-bucket values, then each bucket and grand total. Obtain unrounded source pence if a report only displays rounded pounds; unexplained display differences are not zero.
5. Build a signed bridge: sum of eligible invoice-level balances, plus only genuine opening/adjustment balances not already represented, less unallocated account credits/cash **only where the aged report includes them**, equals the source aged-debtors account total. Reconcile target account balances through the same bridge. Do not add an opening-balance invoice twice. If report semantics differ, show every explicit adjustment and reason; do not force a net match by changing invoice/payment data.
6. Accounts/John confirm the three-way equality: **original SliQ aged-debtors report ↔ reconstructed source balances/bridge ↔ independently extracted Tolra balances/bridge**, at account, bucket and total levels. Reconcile supplier payables/WIP/quotes/POs/items and the later-than-13-October work separately too. Any difference, missing report or unknown allocation remains OPEN; no opening of affected financial use.
7. Recheck complete protected Marpet/security/settings/counters/audit/file content, with only agreed new audit appends accounted separately. Verify every next-number/prefix exceeds the relevant imported high-water mark, including credits/delivery notes; never reset counters to fit the dataset.

## 7. Sign and open only the permitted work

Source/control sheet revision ____; actual loader/run/input/map hashes ____; complete before/after reports ____; unpaid/aged bridge ____; zero unexplained differences? ____; deviations/exclusions/owner/retest ____.

- John — source meaning, completeness and goods-out/paper cut-off: name/signature/date ____.
- Accounts/authorised financial owner — tax, transactions, aged debtors and WIP cost: name/signature/date ____.
- Code — transformation provenance, exact route/target and complete comparison: name/signature/date ____.
- Independent reviewer — scope/verdict/conditions, report and signature/date ____.
- Rhys — C04/C05 evidence/limits decision, then separate final C16 operational GO after controlled smoke: scope/name/signature/time ____.

Missing required signer/result, any unpaid/aged mismatch, unsafe recovery or wrong version means **STOP**. Keep the source files/reports and held writers. Use the existing reviewed recovery decision; never roll back/retry blindly. **After 146 rollback, do not re-apply it on that database or remove retained history/key_source to bypass the guard.** An old backup restores only its actual state and needs later-work reconciliation.

## Sources and M2 handover

Reported real-file facts: Rhys’s current M2 instruction; no original workbook or monetary total was attached/read. Code inspected at `e7581c43b5f92836ceaedcf2716d495392a9d9e6`: `scripts/sliq-import/{load,mapping,parse,reconcile,guard,write,cli}.mjs`, `mappings/sliq.json`; `scripts/sliq-reconcile/{source,compare-money}.mjs`; `tests/GO-LIVE-DATA-LOAD.md`. Application/pack context `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`, scoped #355 proof and corrected M1 papers #362 remain separately pinned sources. No new importer/converter feature or test runtime claimed. Done: reported-shape runbook and blank complete control/acceptance sheets. Open: originals, monetary totals, confirmed conversion/mapping, actual target/loader, rehearsal/full comparison and signatories. Draft only; no SQL, load, main merge or deployment.
