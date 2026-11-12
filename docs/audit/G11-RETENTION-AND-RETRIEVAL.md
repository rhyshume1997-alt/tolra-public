# G11: Retention, audit trail and retrieval sheet

Version 0.1 draft — 4 November 2026. Proposed owner ____; approved by ____; approval date ____; effective date ____.

**NOT EXECUTED.** This is a blank template, not a completed check. Leave unknown fields blank. Record facts and private evidence only after the work happens; do not infer a successful result. Keep completed copies in JNR’s approved private location, never this public repo.

Tolra supports JNR’s quality work. Software and documents cannot certify JNR; JNR is the company audited.

John/Rhys agree each rule with the accountant or adviser where needed. Do not invent a legal period. A backup is not the approved archive or proof that a record can be found. A legal/customer hold stops disposal even when a normal period ends.

## Schedule — complete one decision record for each ID

| Requirement ID / record type | Expected retention and protection | Period / starts from | Who may authorise deletion |
| --- | --- | --- | --- |
| G11-INV — invoices, credits and payments | Original issued details, corrections and payment history stay linked and readable. | ____ / ____ | ____ |
| G11-APP — approvals | Keep approver, date, exact version/text approved and decision. | ____ / ____ | ____ |
| G11-DLN — delivery notes/signatures | Keep note, signature details/files, date and job/customer link together. | ____ / ____ | ____ |
| G11-SLIQ — original SliQ exports | Keep unchanged originals, report/period, exclusions and import/reconciliation records. | ____ / ____ | ____ |
| G11-CHASE — chase evidence | Keep message text, recipient, approval, send outcome and claim/follow-up evidence. | ____ / ____ | ____ |
| G11-AUD — audit trail | Keep required actor/time/change records and their links; protect history. | ____ / ____ | ____ |

For **each schedule ID**, copy this decision record: requirement ID ____; expected result (rule above plus master location/access/backup/disposal method) ____; actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval ____; hold/review date ____.

Nobody receives deletion authority from this draft. An approved retention period does not grant a Tolra delete permission. Do not erase issued records, signatures, approvals or audit history to fix an error. A named authorised operator follows the reviewed retention/hold process and records what was disposed of, why, who approved and when. Ask Rhys if the software prevents deletion; do not bypass it.

## Record-retrieval test — copy for each type above

Requirement ID: G11-RET-____; sample record ID/type ____; agreed retrieval limit ____; search location ____; start time ____; end time ____; elapsed ____.

Expected result: authorised staff find the right original and linked history within the agreed limit; dates, totals, signatures/approvals and attachments match the sample. Actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval ____; missing item/action owner/due ____.

Check screen and exported/archived copy; do not assume a list export contains signatures or all history. See G22 for the timed post-cutover samples.

Sources: [audit events](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/audit-contract.ts); [document ZIP scope](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/lib/year-end-export.tsx); [delivery records](https://github.com/rhyshume1997-alt/tolra-public/blob/68f89ca7b801a10587ff9b51d6c820462847b65a/app/%28dashboard%29/delivery-notes/page.tsx). Live retention and recoverability are not established by source.

Prepared by builder 5 under Rhys’s explicit document-only assignment. Source review and whitespace check only. No live check, production SQL, real data or message to John. Technical source snapshot: `68f89ca7b801a10587ff9b51d6c820462847b65a`; confirm the installed release before use.
