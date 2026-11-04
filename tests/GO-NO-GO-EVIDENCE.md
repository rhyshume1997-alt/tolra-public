# Go / no-go evidence

Status: **NO GO on the evidence available to this worker.** This is not a claim that untested checks failed at runtime. Snapshot: 4 November 2026. Candidate #247: `41c685c416305637d86b580324fff9e6cda037ff`.

PASS means the named check was executed with the stated result. FAIL means a demonstrated unmet condition. NOT TESTED means no execution evidence is available here. Test definitions, document existence and unit success do not prove browser, database, provider or live readiness. No SQL, provider call, real-data import or deployment was run here.

Scope limitation: no file titled "Go Live Operations Pack" was found in fetched repository history. This ledger maps every checkbox in the repository's JNR first-day checklist, every G01-G06 manual step, every candidate reviewer-matrix condition and the release/transfer gates below. An external/private pack must be reconciled item for item before anyone claims complete pack coverage. This missing source is itself a release evidence gap.

Sources:
- First-day checklist: docs/JNR-GO-LIVE-DAY-CHECKLIST.md at `b9d3af361e9d88ccbd2e5ab840f078c862ff3f37`.
- Manual rehearsal: tests/MANUAL-CHECKS-GO-LIVE.md, #263 at `8cecd36e5fc852ae52e564db422f6201c8960a56`.
- Reviewer matrix/release plan: #247 at the pinned candidate above. Later PRs are not assumed merged into it.
- Historical unit execution: codex/work-ownership handover, AT rows; exact heads below. Working-environment logs are not public CI artifacts.

## Release and transfer gates

| Check | Status | Exact evidence or missing proof |
| --- | --- | --- |
| Complete authoritative Operations Pack accounted for | NOT TESTED | Exact pack not found; source coverage limited as stated above |
| Candidate full required CI and independent SAFE verdict | NOT TESTED | No current exact-head CI gate/reviewer artifact captured in this ledger |
| 140-143 release files available in #247 | FAIL | Git tree at 41c685c416305637d86b580324fff9e6cda037ff has none; do not run those releases |
| Backup decrypts and restores with table/money/file equality | NOT TESTED | Runbook #267 specifies proof; no backup/restore executed |
| Baseline through 144, upgrade and apply-twice | NOT TESTED | No SQL execution; frozen catalogue must remain unchanged |
| 138 apply/verify/rollback and retained business data | NOT TESTED | #265 defines proof only; rollback removes chase/claim feature data |
| 144 apply/verify/rollback and disconnect refusal | NOT TESTED | #265 defines proof only |
| 145 apply/verify/rollback and isolation | NOT TESTED | #265 defines proof only; rollback removes setup ticks |
| 146 apply/verify/repeat-refusal/rollback and cap race | NOT TESTED | Existing candidate tests and #265 not executed here; no reinstall after rollback |
| Separate chase atomic-settings production release decision | NOT TESTED | #247 release plan says separate decision; #259 not assumed included |
| Costing 60 golden examples | PASS | #184 a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2: all 60 ran/passed, zero skipped, within 627 focused tests; tracker AT evidence |
| #184 full unit/TypeScript/lint | PASS | Exact head above: 5,285 tests, 371 files, zero failures/skips; tsc exit 0; ESLint 0 errors/12 existing warnings; local at184 logs |
| #185 money tests and full regression | PASS | c857559f517c77ccaed4bac1446757c260bb52e3: 5,004 tests, 369 files, zero failures/skips; tsc exit 0; ESLint 0 errors/12 warnings; local at185 logs. GitHub confirms merged |
| Final candidate database and browser acceptance | NOT TESTED | Earlier unit results on other heads cannot establish this |
| Fake SliQ parser/dry-run decisions | PASS | #264 e26fd743e5145f5d9ee56878cc3733d88d147bdf: 83 fake importer/jobs/decision tests, zero failures/skips; local aw-tests.log; no database writes |
| Real export headers, cutoff, duplicates and source counts | NOT TESTED | No real exports used; John's private signed mapping required |
| Throwaway write import, retries and two-company reconciliation | NOT TESTED | No SQL/import executed here |
| JNR wipe archive, permissions, FK order, protected Marpet state | NOT TESTED | Private combined driver rehearsal unavailable; no wipe executed |
| Real balances, WIP, POs, numbering, payments reconciled | NOT TESTED | Fake parser totals are not real company balances |
| John business sign-off and Rhys technical go-live decision | NOT TESTED | No sign-off evidence supplied or inferred |

## Every first-day checklist box

Each numbered row maps to the checkbox in source order. Evidence: the source is a checklist only, with no ticked result or runtime artifact available.

| ID | Check | Status | Evidence |
| --- | --- | --- | --- |
| DAY-01 | Rhys has confirmed that the release is ready and the checks have passed. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-02 | You have the correct Tolra address and your own sign-in details. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-03 | The office knows who will check payments, send emails and help staff. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-04 | Fill in the contact card below. Do not guess a phone number. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-05 | Open the address Rhys gave you. Enter your username or email and password. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-06 | Change your password if asked. Set up the extra sign-in check if asked. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-07 | Choose the correct company and view if Tolra asks. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-08 | Check the company name says JNR. Stop if it is the wrong company. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-09 | Sign out and back in once so you know your details work. Keep your password to yourself. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-10 | Check the business name, address, phone and email. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-11 | Check the VAT details, payment terms and bank details with accounts. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-12 | Check the logo and the words printed on quotes and invoices. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-13 | Save, reopen and check the saved details. Check a document preview too. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-14 | Add each person's name and their email or username. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-15 | Choose what they need: workshop for shop-floor work, office for office work, admin only for people who look after the company setup. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-16 | Save the person. Give them their own sign-in details privately. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-17 | Ask them to sign in and check they can see the pages they need. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-18 | Open **Customers** and look for them first. Do not add the same customer twice. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-19 | If they are new, choose **New customer**. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-20 | Enter their name, address, contact and email. Check the email carefully. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-21 | Save. Open the customer again and check the details. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-22 | Open **Quotes > New quote**. Choose the right customer. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-23 | Add a clear description, quantities, prices, VAT and the valid-until date. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-24 | If using **Price this part** or the price calculator, check its costs and quantity before adding the price to the quote. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-25 | Choose **Save Quote**. Read the saved draft and its preview. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-26 | Ask the person who agrees prices to check it before it goes to the customer. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-27 | Open **Jobs > New job** or use the agreed quote-to-job route. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-28 | Check the customer, part, quantity and due date. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-29 | Link the agreed quote or order if there is one. Add the drawing and job notes. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-30 | Save. Ask the supervisor to check the job before anyone starts it. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-31 | The person doing the work checks it is the right job before starting time. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-32 | Check with accounts that the work is ready to invoice. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-33 | Open **Invoices > New invoice**, or the agreed job-to-invoice route. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-34 | Check the customer, work, quantities, prices, VAT, due date and bank details. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-35 | Save the draft and read its preview. Ask accounts to check it. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-36 | Issue and send it only when accounts agrees. Do not record money that has not arrived. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-37 | Open **Approvals**. Check the customer, invoice, address and full message. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-38 | If needed, choose **Edit**, then **Save draft**. Read the saved words again. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-39 | **Approve and send** means “I have checked this; send this email now”. It does not mean “mark this invoice paid”. Wait for the result. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-40 | If sending is not set up, the draft stays. Follow the manual-send message; mark it sent manually only after sending it in your email app. | NOT TESTED | Source checkbox unrun; no runtime artifact |
| DAY-41 | **Skip** puts a reminder aside. **Pause chasing for this customer** affects that customer's chasing, not just the draft on screen. | NOT TESTED | Source checkbox unrun; no runtime artifact |

## Every manual rehearsal step

| ID and check | Expected result | Status | Evidence |
| --- | --- | --- | --- |
| G01.1 Sign in to Company A. Open Customers and add `ZZ Rehearsal Customer`, using only the controlled test inbox. | Only A has this fake customer. There is no real customer address on the record. | NOT TESTED | #263 row says NOT RUN |
| G01.2 Open Invoicing, choose New invoice and select that customer. Add a line named `ZZ rehearsal only`, quantity 1, with a made-up price of £1.23. Set the due date to yesterday. Check the VAT shown rather than guessing the total. | The draft clearly says ZZ and shows the chosen price and VAT. No email has gone out. | NOT TESTED | #263 row says NOT RUN |
| G01.3 Save, reopen and issue the invoice using the normal Issue action. Write down its allocated number, total, due date and unpaid balance. | The saved line and total match the draft. There is one issued, unpaid invoice with the normal allocated number. Issuing it has not emailed the customer. | NOT TESTED | #263 row says NOT RUN |
| G01.4 In Company B, search Customers and Invoicing for the exact customer and allocated invoice number. | B sees neither A's customer nor A's invoice. | NOT TESTED | #263 row says NOT RUN |
| G02.1 In A's email schedule settings, review the chase steps. Save them, then reload. | `Chase steps saved.` appears after success. The saved steps remain after reloading. A failed save must not pretend to succeed. | NOT TESTED | #263 row says NOT RUN |
| G02.2 Open Invoicing and use the action to create chase drafts for overdue invoices. Open Approvals and find the ZZ invoice. | There is one draft for the eligible invoice. No message has arrived at the catcher yet. Already-paid invoices have no chase draft. | NOT TESTED | #263 row says NOT RUN |
| G02.3 Choose Edit on the ZZ draft. In the email editor change the subject and add a final line `ZZ exact text check`. Save the edit. Copy the full displayed recipient, subject and body into a local evidence text file. | Reopening shows exactly the saved text, including the last line and line breaks. Editing clears any earlier approval. | NOT TESTED | #263 row says NOT RUN |
| G02.4 Click Approve and send twice quickly on the same reviewed draft. There is no separate Send confirmation button in this card. | The queue shows one successful send. The catcher has exactly one message. Its recipient, subject and full body match your evidence text character for character. A double click has not sent two. | NOT TESTED | #263 row says NOT RUN |
| G02.5 Reload Approvals and the invoice. Check the sent history. | The same draft is no longer awaiting approval. One sent record identifies the approval. The invoice is still unpaid. | NOT TESTED | #263 row says NOT RUN |
| G02.6 Ask Code to use a separate ZZ draft and the local catcher's uncertain-delivery simulation. Approve once, then try the available retry action and reload. | The result is shown as needing checking. The app never automatically resends it; the catcher count stays at one. Do not resolve an uncertain real delivery by sending again. Record Code's simulation evidence. | NOT TESTED | #263 row says NOT RUN |
| G03.1 Reopen the unpaid ZZ invoice. Note its status, amount paid and balance. Click Customer says paid. | Payment to confirm appears and chasing pauses. Status and paid amounts do not become paid; the balance is unchanged. | NOT TESTED | #263 row says NOT RUN |
| G03.2 Reload, then try making another chase draft for it. | The claim is still visible. No new chase is created while payment needs checking. | NOT TESTED | #263 row says NOT RUN |
| G03.3 Read Confirm payment received, but do not complete a payment merely because the customer says so. Choose Not received, resume chasing for this fake claim. | No money is recorded. The claim clears and chasing can resume. The change is logged. | NOT TESTED | #263 row says NOT RUN |
| G03.4 Ask Code to feed fake inbound replies saying `paid`, `remittance` and `payment sent` through the test mailbox. Reopen the affected fake invoices. | Emails/evidence are recorded. None of the three phrases changes paid fields, balance or invoice status automatically. Save Code's inbound-test evidence. | NOT TESTED | #263 row says NOT RUN |
| G04.1 In A, open Settings and the hours settings. Turn Breaks are paid on; save. In B turn it off; save. Set both working weeks to Monday to Friday 08:00 to 16:00. | Each company keeps its own choice after reloading. B's change does not alter A. JNR's unpaid default is not changed by this test. | NOT TESTED | #263 row says NOT RUN |
| G04.2 In each company, open the working-hours summary, the Hours/day screen and that test week's timesheet. | A shows 8:00 paid per day and 40:00 per week. B shows 7:15 paid per day and 36:15 per week. All three places agree for each company. | NOT TESTED | #263 row says NOT RUN |
| G04.3 Check the words describing breaks, then sign out and back in to both companies. | A does not say breaks are unpaid. B correctly shows unpaid deductions. Settings and totals still agree after sign-in. | NOT TESTED | #263 row says NOT RUN |
| G05.1 As A's admin, open Admin → Integrations and find AI. Turn AI off and reload. Open the assistant through the normal navigation. | Off remains saved. AI cannot run for A while off. It does not silently use another key or company. | NOT TESTED | #263 row says NOT RUN |
| G05.2 Leave B off. In A choose the prepared test AI mode and turn AI on. Ask a harmless fake question such as `Summarise the ZZ test work`. | A can get a suggestion from the test provider. It sends no email and changes no invoice or job. B remains off after reloading. | NOT TESTED | #263 row says NOT RUN |
| G05.3 As Rhys, open the platform AI allowance controls and set a small test cap for A only. Reopen A and B as their admins. | A shows its allowance; B is unchanged. Company admins cannot set the Tolra-provided cap. No saved key is revealed in the browser. | NOT TESTED | #263 row says NOT RUN |
| G05.4 As ordinary staff, try opening the integration settings. Ask Code for the two-company isolation and near-limit simultaneous-request test evidence. | Staff cannot change AI mode/caps. A cannot change B. Two simultaneous reservations cannot exceed the cap. Missing automated race evidence is a FAIL, not a click-test pass. | NOT TESTED | #263 row says NOT RUN |
| G05.5 Turn A's AI off again and reload. | The rehearsal leaves both fake companies off. Usage is not reset by switching modes. | NOT TESTED | #263 row says NOT RUN |
| G05.6 Ask Code to show the fake-data missing-global-key proof after a company has selected Tolra-provided mode. Do not remove any live key yourself. | Round-up, RFQ and assistant refuse. They do not use the company key instead. Request history, usage and stored company keys are unchanged. Missing real database proof is BLOCKED. | NOT TESTED | #263 row says NOT RUN |
| G06.1 As A's admin, open Admin → Integrations and find Xero. | The page shows A's own connection state. If server setup is missing, Connect is unavailable or safely refuses with a clear explanation. No other company's account appears. | NOT TESTED | #263 row says NOT RUN |
| G06.2 With the prepared demo registration, click Connect to Xero, sign in to the demo organization and approve. | The app returns to A's Integrations with a connected state and the correct demo organization. No token or saved key appears in the page or address bar. | NOT TESTED | #263 row says NOT RUN |
| G06.3 Before mapping account codes, check the ZZ invoice and the demo Xero organization. Do not press Send now. | No invoice has been exported before the required mappings are ready. Connecting alone is not permission to send accounting records. | NOT TESTED | #263 row says NOT RUN |
| G06.4 Open B's Integrations. Then return to A and disconnect the demo connection. | B cannot see/use A's connection. A shows disconnected afterwards. Tolra invoice/payment amounts are unchanged. | NOT TESTED | #263 row says NOT RUN |
| G07.1 As A's admin, open Admin → Integrations and find the accountant invite card. Enter a second controlled test inbox and create the invitation. | A read-only accountant invitation/link is shown with its expiry. No broader staff/admin role is granted. Only the test address is used. | NOT TESTED | #263 row says NOT RUN |
| G07.2 Open the link in a separate private browser and sign in as that invited test person. | The accountant enters A with the permitted read-only view. They cannot issue/edit invoices, change settings, or enter B. | NOT TESTED | #263 row says NOT RUN |
| G07.3 Back in A, cancel any remaining unused accountant invitation. Under Xero, find `The accountant does the Xero sign-in?` and create its link if registration is ready. | The Xero link is distinct from a Tolra membership invitation. It is scoped to A and expires; it cannot grant access to B. If Xero is not configured, no usable connect link is offered. | NOT TESTED | #263 row says NOT RUN |
| G07.4 Cancel the unused Xero connect link and try it in a private browser. Sign in as ordinary staff and revisit the invitation screen. | The cancelled link refuses. Ordinary staff cannot create/revoke either kind of admin-only invitation. | NOT TESTED | #263 row says NOT RUN |
| G08.1 As Rhys's platform account, open Platform → New company. Enter `ZZ Blank Rehearsal`, a unique slug and the same controlled first-admin email twice. Click Create company. | One empty company is created with its own first admin. No customer email is sent by company creation. | NOT TESTED | #263 row says NOT RUN |
| G08.2 Sign in as that company's admin. Open Customers, Jobs, Quotes, Invoicing and Activity. Search for the exact ZZ invoice from A. | No JNR, Marpet, A/B or sample business records appear, and A's invoice is absent. The company's own creation/setup audit entries are allowed; “blank” does not mean hiding its audit history. | NOT TESTED | #263 row says NOT RUN |
| G08.3 Follow the setup guide: company details; logo/colours; working hours; paid/unpaid breaks; people/roles; accounting connections; AI; email; finally import. Leave optional connections off and do not import anything. | Links open the existing settings pages in that order. Nothing invents sample records, connects an account or sends email by itself. | NOT TESTED | #263 row says NOT RUN |
| G08.4 Save fake company details and a test logo. Choose unpaid breaks and tick only the steps actually checked. Reload. | Details and ticks belong only to the blank company. Branding and break settings persist. Business lists are still empty. | NOT TESTED | #263 row says NOT RUN |
| G08.5 Open A and B again, then open the blank company as ordinary staff and as read-only and elevated support sessions prepared by Code. | A/B settings and records are unchanged. Staff and both support modes cannot see or save setup-progress rows; only that company's own admins can. If the guide appears or saves in support mode, record FAIL. The #239 access fix is already included, so this is a failed candidate check, not a missing future feature. | NOT TESTED | #263 row says NOT RUN |

## Every candidate reviewer condition

| Condition | Status | Evidence |
| --- | --- | --- |
| Approval exact text, edit invalidation, duplicate send and uncertain delivery | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Customer reply never marks invoice paid | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| AI setting/cap company isolation, service-only key | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Tolra-provided mode without a global key never falls back to a configured company key | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Accounting encrypted tokens, provider and company isolation | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Setup progress own admins only, not support/staff | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Legacy email text unchanged, read-only cannot save | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |
| Paid/unpaid settings and timesheets agree across companies | NOT TESTED | Candidate matrix explicitly records database/browser runtime gaps; supporting units do not discharge this condition |

## Decision

Keep go-live blocked until the missing pack is matched, every required runtime row has dated exact-head evidence, failures are resolved and the named reviewers sign off. Keep private evidence private: publish only redacted artifact links and totals, never credentials, bank statements or customer exports. Recheck this ledger whenever the candidate changes.
