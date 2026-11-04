# G19: SliQ proposed exclusions and retrieval

Version 0.1 draft — 4 November 2026. Proposed owner ____; approved by ____; approval date ____; effective date ____.

**NOT EXECUTED.** This is a blank template, not a completed check. Leave unknown fields blank. Record facts and private evidence only after the work happens; do not infer a successful result. Keep completed copies in JNR’s approved private location, never this public repo.

Tolra supports JNR’s quality work. Software and documents cannot certify JNR; JNR is the company audited.

These are proposed exclusions/limits, not John’s accepted decision or proof of a completed import. Do not assume a whole record class is excluded without checking the final import plan. Keep original SliQ exports unchanged and privately accessible. Never put their contents in GitHub.

## Copy this complete record for each item below

Requirement ID ____; record type/period ____; affected record numbers/count/totals ____; original export/report and private location ____; SliQ version/access owner ____; export date/checksum ____; reason/limit ____; how John retrieves the record ____; target/import cross-reference ____; preservation/access/retention rule ____.

Expected result: every affected record remains findable from its original reference, with figures/lines intact and any missing Tolra fields clearly explained. Actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; **John approval (decision, name, date) ____**; follow-up owner/due ____.

| Requirement ID | Proposed exclusion/limit to decide | How John should retrieve it; evidence to check |
| --- | --- | --- |
| G19-QUOTES | Some/all quotes may be held or archived: report customer/status can be insufficient; quote-to-invoice link may not transfer. | Find the original Quotes report using quote number/date; open the original quote in SliQ through approved access. Record which quotes actually imported and which stayed out. |
| G19-QITEM | Quote item lines may not transfer even if a quote header does. | Use original quote and Sales by Quote Item export filtered by quote number. Keep description, quantity, each price and line totals; check they belong to that quote. |
| G19-POITEM | Purchase-order item lines may stay outside Tolra. | Find the original purchase order and Sales by PO Item export using PO number/date; compare quantities and line/net totals with its header. Do not mistake an imported header for complete lines. |
| G19-SOURCE | `source_ref` may be blank: it is a link field, not a separate source record. | Find the original SliQ number in its export. Keep an approved SliQ-to-Tolra number cross-reference if needed. Do not assume numbers match; unresolved or reused numbers must be investigated. |
| G19-WIP | Opening work in progress may be excluded until a complete open-job list and approved writer exist. | John identifies unfinished jobs from original work cards/job records and any available SliQ records; record job, customer, quantity, value and as-at date. No assumption that SliQ has a ready-made open-jobs report. |

Before approving an exclusion, John demonstrates retrieval without editing SliQ or importing anything. Agree who retains lawful access and a readable archive if SliQ later becomes unavailable; test that route too. Missing export/access means unresolved, not silently accepted. Reconcile included + excluded/held counts and money to the agreed source population, without double counting.

Sources: [I5 source-linked risks](https://github.com/rhyshume1997-alt/tolra-public/blob/2429eda5831a93f6966a89ec8ba8c6a4dde2e1ae/docs/iso9001/RISKS-AND-OPPORTUNITIES-REGISTER.md) and the final approved import/exclusions plan (private location/version ____). No private plan contents or real records are included here.

Prepared by builder 5 under Rhys’s explicit document-only assignment. Source review and whitespace check only. No live check, production SQL, real data or message to John. Technical source snapshot: `68f89ca7b801a10587ff9b51d6c820462847b65a`; confirm the installed release before use.
