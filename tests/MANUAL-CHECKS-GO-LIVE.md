# Rhys's go-live rehearsal

Use the reviewed candidate from PR #247 on Code's disposable test copy. This is a rehearsal, not a live-company check. These steps have **not been run** by this document's author. Leave every evidence box marked NOT RUN until you do it.

Before starting, Code prepares two fake companies (A and B), their separate admin and ordinary staff logins, and a third unused company name. Keep each company in a separate browser profile so it is obvious which is open. Use a test inbox you control and a mail catcher that cannot deliver to real customers. Code must have completed the database upgrade rehearsal and separately reviewed the setup/AI/chase settings database changes. This document does not apply any of them.

Write down the app address, candidate commit, date, your name and the two company names. Have Code show that the address is the test copy. Keep JNR, Marpet, real customer addresses and real accounting organizations out of these steps. If a step fails, write what happened and keep the screenshot; do not mark it passed or work around it on the live system.

| Rehearsal details | Fill in |
| --- | --- |
| App address and candidate commit | NOT RECORDED |
| Date and person checking | NOT RECORDED |
| Company A / Company B | NOT RECORDED |
| Test inbox / local mail catcher | NOT RECORDED |
| Code's database rehearsal evidence | NOT RECORDED |

For each row below, replace NOT RUN with PASS or FAIL and an evidence filename. Do not put passwords, API keys, invite links or connection tokens in screenshots or this file.

## G01 — Create the ZZ test invoice

Use the same ZZ invoice in G02 and G03. Its description is the test label; let Tolra allocate its normal invoice number. Do not reset or overwrite numbering to make a number start with ZZ.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G01.1 Sign in to Company A. Open Customers and add `ZZ Rehearsal Customer`, using only the controlled test inbox. | Only A has this fake customer. There is no real customer address on the record. | NOT RUN |
| G01.2 Open Invoicing, choose New invoice and select that customer. Add a line named `ZZ rehearsal only`, quantity 1, with a made-up price of £1.23. Set the due date to yesterday. Check the VAT shown rather than guessing the total. | The draft clearly says ZZ and shows the chosen price and VAT. No email has gone out. | NOT RUN |
| G01.3 Save, reopen and issue the invoice using the normal Issue action. Write down its allocated number, total, due date and unpaid balance. | The saved line and total match the draft. There is one issued, unpaid invoice with the normal allocated number. Issuing it has not emailed the customer. | NOT RUN |
| G01.4 In Company B, search Customers and Invoicing for the exact customer and allocated invoice number. | B sees neither A's customer nor A's invoice. | NOT RUN |

## G02 — Review and send the exact chase text

Code must have enabled test email delivery to the local catcher. Never point this rehearsal at a real customer mailbox or real mail delivery service.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G02.1 In A's email schedule settings, review the chase steps. Save them, then reload. | `Chase steps saved.` appears after success. The saved steps remain after reloading. A failed save must not pretend to succeed. | NOT RUN |
| G02.2 Open Invoicing and use the action to create chase drafts for overdue invoices. Open Approvals and find the ZZ invoice. | There is one draft for the eligible invoice. No message has arrived at the catcher yet. Already-paid invoices have no chase draft. | NOT RUN |
| G02.3 Choose Edit on the ZZ draft. In the email editor change the subject and add a final line `ZZ exact text check`. Save the edit. Copy the full displayed recipient, subject and body into a local evidence text file. | Reopening shows exactly the saved text, including the last line and line breaks. Editing clears any earlier approval. | NOT RUN |
| G02.4 Use Approve and send and read any confirmation. Complete the confirmation, clicking Send twice quickly where possible. | The queue shows one successful send. The catcher has exactly one message. Its recipient, subject and full body match your evidence text character for character. A double click has not sent two. | NOT RUN |
| G02.5 Reload Approvals and the invoice. Check the sent history. | The same draft is no longer awaiting approval. One sent record identifies the approval. The invoice is still unpaid. | NOT RUN |
| G02.6 Ask Code to use a separate ZZ draft and the local catcher's uncertain-delivery simulation. Approve once, then try the available retry action and reload. | The result is shown as needing checking. The app never automatically resends it; the catcher count stays at one. Do not resolve an uncertain real delivery by sending again. Record Code's simulation evidence. | NOT RUN |

The exact-text, double-send and uncertain-delivery checks all matter. A visible success message alone is not proof of correct sending. Code should also provide the stale-approval test: an edit between review and send must refuse the old approval.

## G03 — A paid claim is a check, not a payment

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G03.1 Reopen the unpaid ZZ invoice. Note its status, amount paid and balance. Click Customer says paid. | Payment to confirm appears and chasing pauses. Status and paid amounts do not become paid; the balance is unchanged. | NOT RUN |
| G03.2 Reload, then try making another chase draft for it. | The claim is still visible. No new chase is created while payment needs checking. | NOT RUN |
| G03.3 Read Confirm payment received, but do not complete a payment merely because the customer says so. Choose Not received, resume chasing for this fake claim. | No money is recorded. The claim clears and chasing can resume. The change is logged. | NOT RUN |
| G03.4 Ask Code to feed fake inbound replies saying `paid`, `remittance` and `payment sent` through the test mailbox. Reopen the affected fake invoices. | Emails/evidence are recorded. None of the three phrases changes paid fields, balance or invoice status automatically. Save Code's inbound-test evidence. | NOT RUN |

## G04 — Paid and unpaid breaks agree everywhere

For an exact comparison, Code supplies the same five completed 08:00–16:00 days in A and B, no overtime or extra clocked breaks, lunch 30 minutes, break 15 minutes and the same minimum-day threshold (below eight hours). Use a completed unlocked test week. Do not alter a real worker's record.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G04.1 In A, open Settings and the hours settings. Turn Breaks are paid on; save. In B turn it off; save. Set both working weeks to Monday–Friday 08:00–16:00. | Each company keeps its own choice after reloading. B's change does not alter A. JNR's unpaid default is not changed by this test. | NOT RUN |
| G04.2 In each company, open the working-hours summary, the Hours/day screen and that test week's timesheet. | A shows 8:00 paid per day and 40:00 per week. B shows 7:15 paid per day and 36:15 per week. All three places agree for each company. | NOT RUN |
| G04.3 Check the words describing breaks, then sign out and back in to both companies. | A does not say breaks are unpaid. B correctly shows unpaid deductions. Settings and totals still agree after sign-in. | NOT RUN |

## G05 — AI off, then on, for one company

Code prepares the fake AI provider/test connection before the on check. Only Rhys's authorized platform account can set the Tolra-provided allowance. Company admins must never be able to raise that allowance themselves.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G05.1 As A's admin, open Admin → Integrations and find AI. Turn AI off and reload. Open the assistant through the normal navigation. | Off remains saved. AI cannot run for A while off. It does not silently use another key or company. | NOT RUN |
| G05.2 Leave B off. In A choose the prepared test AI mode and turn AI on. Ask a harmless fake question such as `Summarise the ZZ test work`. | A can get a suggestion from the test provider. It sends no email and changes no invoice or job. B remains off after reloading. | NOT RUN |
| G05.3 As Rhys, open the platform AI allowance controls and set a small test cap for A only. Reopen A and B as their admins. | A shows its allowance; B is unchanged. Company admins cannot set the Tolra-provided cap. No saved key is revealed in the browser. | NOT RUN |
| G05.4 As ordinary staff, try opening the integration settings. Ask Code for the two-company isolation and near-limit simultaneous-request test evidence. | Staff cannot change AI mode/caps. A cannot change B. Two simultaneous reservations cannot exceed the cap. Missing automated race evidence is a FAIL, not a click-test pass. | NOT RUN |
| G05.5 Turn A's AI off again and reload. | The rehearsal leaves both fake companies off. Usage is not reset by switching modes. | NOT RUN |

## G06 — Xero connection screen

Use a Xero demo organization and a free registered developer app only. Code prepares registration and encrypted-token settings. If registration is absent, the safe refusal is a pass for the refusal check, but the successful-connect rows remain NOT RUN/blocked.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G06.1 As A's admin, open Admin → Integrations and find Xero. | The page shows A's own connection state. If server setup is missing, Connect is unavailable or safely refuses with a clear explanation. No other company's account appears. | NOT RUN |
| G06.2 With the prepared demo registration, click Connect to Xero, sign in to the demo organization and approve. | The app returns to A's Integrations with a connected state and the correct demo organization. No token or saved key appears in the page or address bar. | NOT RUN |
| G06.3 Before mapping account codes, check the ZZ invoice and the demo Xero organization. Do not press Send now. | No invoice has been exported before the required mappings are ready. Connecting alone is not permission to send accounting records. | NOT RUN |
| G06.4 Open B's Integrations. Then return to A and disconnect the demo connection. | B cannot see/use A's connection. A shows disconnected afterwards. Tolra invoice/payment amounts are unchanged. | NOT RUN |

## G07 — Accountant invite screen

There are two different links: a read-only accountant invitation to Tolra, and a link for an accountant to do the Xero sign-in. Check both; do not copy either real token into evidence.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G07.1 As A's admin, open Admin → Integrations and find the accountant invite card. Enter a second controlled test inbox and create the invitation. | A read-only accountant invitation/link is shown with its expiry. No broader staff/admin role is granted. Only the test address is used. | NOT RUN |
| G07.2 Open the link in a separate private browser and sign in as that invited test person. | The accountant enters A with the permitted read-only view. They cannot issue/edit invoices, change settings, or enter B. | NOT RUN |
| G07.3 Back in A, cancel any remaining unused accountant invitation. Under Xero, find `The accountant does the Xero sign-in?` and create its link if registration is ready. | The Xero link is distinct from a Tolra membership invitation. It is scoped to A and expires; it cannot grant access to B. If Xero is not configured, no usable connect link is offered. | NOT RUN |
| G07.4 Cancel the unused Xero connect link and try it in a private browser. Sign in as ordinary staff and revisit the invitation screen. | The cancelled link refuses. Ordinary staff cannot create/revoke either kind of admin-only invitation. | NOT RUN |

## G08 — A new company starts blank

This company must be separate from any demo seed. Do not run #243 or the superseded #244 seed to create it.

| Step: what to click | What should happen | Result and evidence |
| --- | --- | --- |
| G08.1 As Rhys's platform account, open Platform → New company. Enter `ZZ Blank Rehearsal`, a unique slug and the same controlled first-admin email twice. Click Create company. | One empty company is created with its own first admin. No customer email is sent by company creation. | NOT RUN |
| G08.2 Sign in as that company's admin. Open Customers, Jobs, Quotes, Invoicing and Activity. Search for the exact ZZ invoice from A. | No JNR, Marpet, A/B or sample business records appear, and A's invoice is absent. The company's own creation/setup audit entries are allowed; “blank” does not mean hiding its audit history. | NOT RUN |
| G08.3 Follow the setup guide: company details; logo/colours; working hours; paid/unpaid breaks; people/roles; accounting connections; AI; email; finally import. Leave optional connections off and do not import anything. | Links open the existing settings pages in that order. Nothing invents sample records, connects an account or sends email by itself. | NOT RUN |
| G08.4 Save fake company details and a test logo. Choose unpaid breaks and tick only the steps actually checked. Reload. | Details and ticks belong only to the blank company. Branding and break settings persist. Business lists are still empty. | NOT RUN |
| G08.5 Open A and B again, then open the blank company as ordinary staff and as read-only and elevated support sessions prepared by Code. | A/B settings and records are unchanged. Staff and both support modes cannot see or save setup-progress rows; only that company's own admins can. If the guide leaks into support mode, record FAIL and review #239 before go-live. | NOT RUN |

## Finish and decision

Record the exact allocated ZZ invoice number and evidence filenames. Ask Code to confirm there was one captured chase, no real external delivery, no unplanned accounting export and no cross-company change. Keep history/evidence; do not reset document numbering or run a wipe as cleanup. Leave test AI off and unused invite links cancelled.

The rehearsal passes only when every required row has PASS and evidence, Code's upgrade/catalogue checks and cap-race proof pass, and all reviewer conditions are met. Any NOT RUN or FAIL stays visible in the go-live decision. No SQL execution, deployment or go-live is authorized by this checklist.
