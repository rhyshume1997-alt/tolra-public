# DRAFT - not approved

# Tolra: click-by-click demo script for John (shop owner)

Status: DRAFT. Not approved by Rhys. Do not use with John until it is approved.
Base: commit `e70f6633` on branch `claude/docs-john-demo-script`. This file is the only change.

## How this was built

- Every button name, label, menu name and screen title below is copied from the app code (`components/`, `app/`) or from the browser specs (`tests/e2e/*.spec.ts`).
- Each step has an **Expected result** only where a file in the repo asserts it. The reference is given as `file:line`.
- Where nothing in the repo asserts the result, the step says **NOT VERIFIED - check on the day**.
- The specs run against test databases and a mock mail server. They prove the screens work in the test set-up. They do not prove a real Microsoft 365, Xero or e-mail provider works.
- No numbers, timings, screenshots or results have been invented. Figures on screen must be read on the day, not quoted from this script.

Legend: **Click** = what to press. **You should see** = what John sees. **Expected result** = the asserted outcome, with source. **NOT VERIFIED** = not asserted in the repo.

---

## 1. Prep checklist (before John joins)

### 1.1 Demo data is synthetic

- Use only a throwaway, local demo company. Never a live company, a real customer, a real price or a real person's data.
- Two seed sources exist. They do not match each other, so pick one and check it before the demo:
  - `origin/claude/job-u-demo-seed`, file `tests/DEMO-DATA.md`: company "Tolra Demo"; customers "Example Customer A, B and C"; jobs `DEMO-001` to `DEMO-003`; demo admin `demo.admin@example.test`; command `node scripts/demo-seed/cli.mjs --yes-this-is-a-throwaway-database`. That command is not in this worktree (`scripts/demo-seed` is absent on `e70f6633`).
  - `origin/codex/u-tolra-demo-seed`, file `scripts/seed-tolra-demo.ts`: company "Tolra Demo"; owner `demo-owner@example.test`; database `tolra_demo_throwaway` on loopback only; plan labelled "FAKE SCREENSHOT DATA - no real customers or prices"; jobs `DEMO-J-001` to `DEMO-J-003`; machines "Example Machine A" and "Example Machine B"; invoices `DEMO-INV-PAID`, `DEMO-INV-DUE`, `DEMO-INV-OVERDUE`.
- Both sources were read with `git show` only. Neither was run.
- Do not read money amounts out loud from the demo data. They are placeholders.

### 1.2 Environment flags (must be off)

- `NEXT_PUBLIC_DEMO_MODE` must NOT be `true`. In demo mode the app shows built-in sample records when the database is empty or unreachable (`lib/demo.ts:1-7`), and the "Email now" button is hidden on invoices (`app/(dashboard)/invoices/page.tsx:1693`). If it is on, the script will not match the screens.
- The left menu item "AI" only appears when the server has the AI helper on (`components/sidebar.tsx:50` and comment above it). If it is off, the step is skipped.

### 1.3 Who signs in as which role

| Role | Used for | Menu items seen (`components/sidebar.tsx:46-83`) |
|---|---|---|
| Admin | Whole demo, including Integrations and Settings | All items |
| Office | Quotes, invoices, sales orders, customers | Dashboard, Job Board, Machine Schedule, Weekly hours, Invoicing, etc. (no Integrations, no Settings, no User Management) |
| Workshop | Job Board start and finish, Machine Schedule, Weekly hours, Delivery Notes | Dashboard, Job Board, Machine Schedule, Weekly hours, Delivery Notes |
| Viewer | Read-only check | Dashboard, Job Board, Machine Schedule |

- Use an **Admin** account for John's demo, because Integrations (steps 37-42) is admin-only.
- Workshop and Viewer roles cannot see "Email now" (`tests/e2e/email-one-click.spec.ts:95-97`).

### 1.4 Admin sign-in needs an authenticator app

- Admins sign in with a second step. The first time, they scan a QR code and type the 6-digit code (`app/mfa/page.tsx:145-149`).
- Have the phone with the authenticator app ready. Codes change every 30 seconds.
- If the phone is lost, another admin resets it under Admin > Users (`app/mfa/page.tsx:163`).

### 1.5 Settings that must be in place

- Customers "Example Customer A" (and B, C) exist before creating a quote, otherwise the customer dropdown is empty (`tests/e2e/walkthrough.spec.ts:91-95` selects an existing customer).
- At least one machine exists before a booking is made (`tests/e2e/walkthrough.spec.ts:183` creates one; the demo seed lists "Example Machine A" and "Example Machine B").
- Microsoft 365: on the test server it is "Not set up on this server" (`tests/e2e/integrations-connect.spec.ts:136`). Decide before the demo whether to show that state. Do not connect a real mailbox.
- Xero: "Not set up yet" unless the server has Xero app details (`tests/e2e/integrations-connect.spec.ts:141`).
- AI: OFF. Xero transfers: OFF. Do not switch either on for John. Changing either asks for a fresh authenticator code (see step 41-42).

### 1.6 Other prep

- Screen: the walkthrough spec uses a 1280 x 900 window (`tests/e2e/walkthrough.spec.ts:27`). Use a laptop screen of similar size. NOT VERIFIED that this matters to John.
- Browser and device used on the day: NOT VERIFIED.
- Turn off real e-mail sending to customers before the demo. NOT VERIFIED how this is done on the day.

---

## 2. Steps

### Part A - Sign in

**Step 1. Open the sign-in page.**
- Click: open the app's sign-in page (`/login`).
- You should see: a "Sign in" heading, a field "Username or email", a field "Password", and a "Sign in" button.
- Expected result: asserted by `tests/e2e/integrations-connect.spec.ts:52-54` (uses those labels and button). The dark variant text is at `components/ui/sign-in-dark.tsx:86,91,123`. Which variant shows on the day: NOT VERIFIED.

**Step 2. Enter the username and password.**
- Click: type into "Username or email" and "Password", then click "Sign in".
- You should see: a "6-digit code" box.
- Expected result: `tests/e2e/integrations-connect.spec.ts:52-56`. First-time admin set-up (QR code, button "Turn on and continue"): `app/mfa/page.tsx:145,166`. NOT VERIFIED on the day whether it is a first-time set-up.

**Step 3. Enter the 6-digit code.**
- Click: type the code from the authenticator app, then click "Continue".
- You should see: the company's start page.
- Expected result: the click on "Continue" is asserted at `tests/e2e/integrations-connect.spec.ts:57`. Where John lands is NOT VERIFIED.
- If John belongs to more than one company you may see "Choose a company" (`app/choose-company/page.tsx:81`). If he has more than one role you may see "Choose Your View" with "Continue as Admin" (`app/select-role/page.tsx:79,97`). Choose the company and role for the demo. NOT VERIFIED when these appear.

### Part B - Dashboard

**Step 4. Open the Dashboard.**
- Click: "Dashboard", under the "Workspace" heading in the left menu (`components/sidebar.tsx:46-47`).
- You should see: the heading "Dashboard" and tiles titled "Money owed by age", "Open jobs by status", "Quotes, last 90 days", "Revenue, last 6 months", "Machine load this week" and "Finished on time" (titles in `app/(dashboard)/dashboard/page.tsx`).
- Expected result: heading and tile titles are in code. The figures in the tiles: NOT VERIFIED - check on the day. Do not quote them.

### Part C - Quotes

**Step 5. Open the Quote Generator.**
- Click: "Quote Generator", under "Sales Pipeline" (`components/sidebar.tsx:57`).
- You should see: the heading "Quote Generator" (`app/(dashboard)/quotes/page.tsx`) and sections named "Draft quotes", "Sent quotes" and "Expired quotes".
- Expected result: region names asserted at `tests/e2e/walkthrough.spec.ts:118-129`.

**Step 6. Start a new quote.**
- Click: "New quote".
- You should see: a dialog titled "Quote Builder".
- Expected result: `tests/e2e/walkthrough.spec.ts:91-92`.

**Step 7. Fill in the quote and save it.**
- Click: choose the customer in the first dropdown (for example "Example Customer A"); type a date into "Valid until"; type into "Quote description" and "Description"; type a number into "Unit price"; then click "Save Quote".
- You should see: the dialog closes, and the quote card is in "Draft quotes".
- Expected result: fields and button asserted at `tests/e2e/walkthrough.spec.ts:93-104`.

**Step 8. Send the quote.**
- Click: "Send" on the draft card, then "Yes, send" in the confirmation box.
- You should see: a file download starts, and a dialog whose title ends "gone to the customer?" with a button containing "sent it".
- Expected result: "Yes, send" and the dialog shape are in `tests/e2e/helpers.ts:182-187`. The download and the "sent it" dialog are at `tests/e2e/walkthrough.spec.ts:107-112`.
- NOT VERIFIED: whether an e-mail actually leaves Tolra at this step. The spec waits for the download and a manual "sent it" confirmation. Do not tell John an e-mail was sent.

**Step 9. Confirm the quote went out.**
- Click: the button containing "sent it".
- You should see: a message "moved from Drafts to Sent"; the card is now in "Sent quotes" and has a "Resend" button.
- Expected result: `tests/e2e/walkthrough.spec.ts:112-117`.

**Step 10 (optional). Show the past-date rule.**
- Click: "New quote" again. Set "Valid until" to a date in the past, save it, then open the "Done (" filter and find the card "Date has passed". Click "Send".
- You should see: a message saying the quote's date has passed and asking the user to edit it and set a new date before sending.
- Expected result: `tests/e2e/walkthrough.spec.ts:120-135`.

**Step 11. Accept the quote.**
- Click: "View" on the quote card, then "Mark Accepted" in the dialog "<quote ref> quote details".
- You should see: a dialog "Mark <ref> as accepted?" with a field "Customer PO (optional)".
- Expected result: `tests/e2e/quote-to-job.spec.ts:29-33`.

**Step 12. Confirm the acceptance.**
- Click: type a customer PO if you have one, then click "Confirm Accepted".
- You should see: the "Mark Accepted" button is gone from the quote details; a message "Sales order PO-... created and job <job no> made, not started." with a button "Open job <job no>".
- Expected result: `tests/e2e/quote-to-job.spec.ts:34-37` (button gone) and `tests/e2e/quote-to-job.spec.ts:50-52` (message and button).

**Step 13. Open the new job from the message.**
- Click: "Open job <job no>".
- You should see: the Job Board with that job scrolled to and highlighted.
- Expected result: `tests/e2e/quote-to-job.spec.ts:53-54`.

**Step 14. Convert a sales order to a job.**
- Click: "Sales Orders" in the left menu (`components/sidebar.tsx:58`). On an order that has not been converted, click "Convert to Job" on its row.
- You should see: the page moves to the Job Board with the new job highlighted (URL contains `/jobs?job=`).
- Expected result: `tests/e2e/walkthrough.spec.ts:215-218`.
- After conversion: the order leaves the main list. Open the "Done (" filter and the order is there with no "Convert to Job" button.
- Expected result: `tests/e2e/walkthrough.spec.ts:219-223`.

### Part D - Job Board

**Step 15. Create a job by hand (optional).**
- Click: "Job Board" in the left menu (`components/sidebar.tsx:64`), then "New job".
- You should see: a dialog titled "New job".
- Expected result: `tests/e2e/new-job.spec.ts:52-54`. Fields and the "Create job" button are asserted at `tests/e2e/new-job.spec.ts:67`. The created job's result: NOT VERIFIED - check on the day.

**Step 16. Read the traffic lights.**
- Click: nothing; look at the job rows.
- You should see: "On time" on jobs due in the future and "Late" on jobs past due.
- Expected result: `tests/e2e/walkthrough.spec.ts:42-43`.

**Step 17. Start a job.**
- Click: the control on the job row whose name starts with "Start" (it can also read "Resume" or "Start timer", `tests/e2e/helpers.ts:193-194`). If you are asked to pick a machine, choose the bench option. The bench option's label: NOT VERIFIED.
- You should see: the row shows "On the bench".
- Expected result: `tests/e2e/walkthrough.spec.ts:46-47`.

**Step 18. Finish the job.**
- Click: "Finish" on the row, then "Finish job" in the confirmation dialog.
- You should see: a message "Job finished: Waiting for inspection", and the row shows "Waiting for inspection".
- Expected result: `tests/e2e/walkthrough.spec.ts:49-53`. Dialog and button names: `tests/e2e/helpers.ts:201-206`.

**Step 19. Record the inspection.**
- Click: the "Waiting for inspection" filter button, then "Inspected" on the row. In the dialog "Record inspection", fill "Acceptance criteria (required)" and "Measured notes (required)". If the admin who finished the job is inspecting it, also fill "Reason you are inspecting it yourself". Click "Record inspection".
- You should see: a message containing "inspected: Complete".
- Expected result: `tests/e2e/walkthrough.spec.ts:55-63`. The reason field is at `tests/e2e/walkthrough.spec.ts:64`; the button at line 65.

**Step 20. Show the completed job.**
- Click: the "Complete (" filter button.
- You should see: the row shows "Complete".
- Expected result: `tests/e2e/walkthrough.spec.ts:66-68`.

**Step 21. Show Hours and Days on average job time.**
- Click: "Hours", then "Days", on the "Average job time" figure.
- You should see: the figure switches between hours and days.
- Expected result: the buttons and the switch are asserted at `tests/e2e/walkthrough.spec.ts:70-84`. The meaning of "Average job time" is at `tests/e2e/walkthrough.spec.ts:32`. The figures on screen: NOT VERIFIED - check on the day.

### Part E - Machine schedule

**Step 22. Open the Machine Schedule.**
- Click: "Machine Schedule" in the left menu (`components/sidebar.tsx:65`).
- You should see: the heading "Machine Schedule" (`app/(dashboard)/schedule/page.tsx`).
- Expected result: heading is in code. The chart layout: NOT VERIFIED.

**Step 23. Book a job onto a machine.**
- Click: "New booking". In the dialog, choose a "Job", type a "Job number", choose a "Machine", type "Estimated hours", then click "Book job" (the button can read "Book anyway" if the app warns).
- You should see: a message "Job booked onto machine", and a bar on the chart titled "<job no> on <machine>".
- Expected result: `tests/e2e/walkthrough.spec.ts:185-194`.

**Step 24. Remove the booking.**
- Click: the bar, then "Remove booking", then "Yes, remove booking".
- You should see: an alert "Remove this booking? This can't be undone." and then "Booking removed". The bar is gone, and stays gone after a page reload.
- Expected result: `tests/e2e/walkthrough.spec.ts:196-205`.

### Part F - Time sheets and attendance

**Step 25. Open Weekly hours.**
- Click: "Weekly hours" in the left menu (`components/sidebar.tsx:66`; admin, office and workshop only).
- You should see: two tabs, "Today" and "This week".
- Expected result: `components/time/hours-tabs.tsx:6-7,24-25`.

**Step 26. Clock in.**
- Click: "Clock in" on the "Today" tab.
- You should see: the "Clock in" button is replaced by "Clock out".
- Expected result: `components/time/day-sheet.tsx:274-276` (code shows "Clock out" when clocked in and "Clock in" otherwise). The on-screen result on the day: NOT VERIFIED.

**Step 27. Take a break (optional).**
- Click: "Break start", then "Break end".
- You should see: the two break labels are offered.
- Expected result: labels in `components/time/day-sheet.tsx:58`. Placement and the on-screen result: NOT VERIFIED - check on the day.

**Step 28. Clock out.**
- Click: "Clock out".
- You should see: the day's card "Clock in and out" shows the entry.
- Expected result: card title at `components/time/day-sheet.tsx:301`. The entry itself: NOT VERIFIED - check on the day.

**Step 29. Show the week.**
- Click: "This week".
- You should see: the week's paid hours per person and an approval area. An "Approve without them" option exists in the week review.
- Expected result: label in `components/time/week-review.tsx`. Who can approve, and the on-screen layout: NOT VERIFIED - check on the day.

### Part G - Deliver

**Step 30. Create a delivery note.**
- Click: "Delivery Notes" in the left menu (`components/sidebar.tsx:70`), then "New delivery note", then "Without an order" (if the job has no order), fill it in, then click "Save Delivery Note".
- You should see: the new delivery note.
- Expected result: button names at `tests/e2e/new-job.spec.ts:191-200`. The saved result: NOT VERIFIED - check on the day.

**Step 31. E-mail the delivery note.**
- Click: "Email Customer" on the delivery note row. In the dialog "Email delivery note", you can click "Copy Email Body", then "Mark as Sent".
- You should see: a dialog "Email delivery note" with those buttons.
- Expected result: `tests/e2e/delivery-email.spec.ts:33-38`. Whether the row then offers "Mark Signed": `tests/e2e/delivery-email.spec.ts:59` (asserted in the spec's set-up state only).

### Part H - Invoice and send

**Step 32. Issue an invoice.**
- Click: "Invoicing" in the left menu (`components/sidebar.tsx:67`). Click "View" on the customer's row. In "<ref> invoice details", click "Issue Invoice", then "Issue Invoice" in the confirmation.
- You should see: the invoice stays open with a "Send to Customer" button. The "Issue" button is gone.
- Expected result: `tests/e2e/issue-and-send.spec.ts:28-36`.

**Step 33. Issue and send in one go (alternative to step 32).**
- Click: "Issue & send" in the invoice details, then "Issue & send" in the confirmation.
- You should see: a PDF download, then a dialog "Has <ref> gone to the customer?" with a button containing "sent it".
- Expected result: `tests/e2e/issue-and-send.spec.ts:39-51`. The sent date is recorded only after John clicks "sent it" (`tests/e2e/issue-and-send.spec.ts:52-56`).

**Step 34. Record a payment.**
- Click: "Record payment" on the invoice row or in the details. In "Record a payment on <ref>", click "Pay balance in full" or type an amount, then "Save payment".
- You should see: the payment dialog closes; the invoice moves to "Part paid" or "Paid" (use the "Part paid" filter, `tests/e2e/invoice-payments.spec.ts:67`).
- Expected result: button names at `tests/e2e/invoice-payments.spec.ts:36-50`. The status after saving: NOT VERIFIED - check on the day.

**Step 35. Send an invoice by e-mail.**
- Click: "View" on the issued invoice, then "Email now" in the details.
- You should see: a dialog "Send by e-mail" with "To" filled from the customer on file and "Subject" filled with the invoice reference. Untick the "Attach ..." box if you do not want the PDF. Click "Send". The status shows "Sent".
- Expected result: `tests/e2e/email-one-click.spec.ts:46-56`. The sent date is recorded afterwards: `tests/e2e/email-one-click.spec.ts:57-59`.
- NOT VERIFIED: a real mailbox receives this. The spec runs against a mock mail server (`tests/e2e/integrations-connect.spec.ts` uses `/__emails` on a mock port). Do not promise John a real e-mail on this step.

### Part I - Integrations (admin only)

**Step 36. Open Integrations.**
- Click: "Integrations" under "Resources" in the left menu (`components/sidebar.tsx:82`).
- You should see: the heading "Integrations" and four cards in this order: AI, Xero, Microsoft 365, Resend.
- Expected result: heading `app/(dashboard)/admin/integrations/page.tsx`; card order `components/integrations/integrations-overview.tsx:15` and `app/(dashboard)/admin/integrations/page.tsx:23`.

**Step 37. Show the Microsoft 365 card. Do not click Connect.**
- Click: nothing. Point at the Microsoft 365 card and its button "Connect Microsoft 365".
- You should see (no app details on the server): the line "Connection: Not set up on this server" and a disabled "Connect Microsoft 365" button.
- Expected result: `tests/e2e/integrations-connect.spec.ts:133-137`.
- When app details are set up: the button is enabled. It reads "Reconnect" once connected (`components/integrations/microsoft-setup-card.tsx:142`). Clicking it starts a real Microsoft sign-in: NOT VERIFIED, and out of scope for this demo.

**Step 38. Show the Xero card. Do not click Connect.**
- Click: nothing. Point at the Xero card and its button "Connect to Xero".
- You should see (no app details on the server): the message "Not set up yet: Tolra's Xero connection is switched on at go-live. Nothing to do here." and a disabled "Connect to Xero" button.
- Expected result: `tests/e2e/integrations-connect.spec.ts:141-142`. The "Not connected" tools line: `tests/e2e/integrations-connect.spec.ts:154`.
- The button text in code: `components/integrations/xero-setup-card.tsx:77`.

**Step 39. Show the accountant connect link (describe only).**
- Click: nothing. Under the Xero tools (More), point at the field "Accountant's e-mail address" and the button "E-mail the accountant a connect link".
- You should see: these only when Xero is set up and the database is ready. Without that, the link is not offered at all.
- Expected result: `components/integrations-panel.tsx:244-254` (the field, the button and the conditions). After a send, the page says "Sent to <masked address>. It works once, until ... (24 hours)." (`components/integrations-panel.tsx:257`). The masked address and the 24-hour limit are asserted at `tests/e2e/integrations-connect.spec.ts:399-404`. Open links are listed with a "Cancel" button and a dialog "Cancel this connect link?" (`tests/e2e/integrations-connect.spec.ts:502-504`).
- NOT VERIFIED: that the accountant receives the e-mail, that Xero accepts the sign-in, or that any real Xero call works. The spec intercepts the redirect and does not follow it. Do not click the send button in the demo.

**Step 40. Show the AI switch. Do not change it.**
- Click: nothing. Point at the AI card and its "Turn on AI" switch.
- You should see: the switch is OFF by default.
- Expected result: `components/integrations/ai-setup-card.tsx:22,157`. The switch is disabled when a server-level emergency switch or the key is missing (`components/integrations/ai-setup-card.tsx:25`). What the John sees on the day: NOT VERIFIED.
- Changing it asks for a fresh 6-digit code (`components/integrations/ai-setup-card.tsx:14` imports the code step; the dialog text is at `components/authenticator-code-dialog.tsx:46`). NOT VERIFIED in tests that this prompt appears on this switch.

**Step 41. Show the Xero "Turn on transfers" switch. Do not change it.**
- Click: nothing. Point at the switch "Turn on transfers" in the Xero card.
- You should see: it is OFF.
- Expected result: `components/integrations/xero-setup-card.tsx:91-93` (a company's own switch, changed only with a fresh authenticator code) and `lib/integrations/xero-setup-state.ts:81`. The on-screen state on the day: NOT VERIFIED.

**Step 42. Show the Resend card. Do not send a test e-mail.**
- Click: nothing. Point at the Resend card.
- You should see: "Not set up on this server" (when the server has no key), and a button "Check domain" that is disabled in that state.
- Expected result: `components/integrations/resend-setup-card.tsx:16,107`. The "Send a test e-mail to yourself" step is described at `components/integrations/resend-setup-card.tsx:92` and is not part of the demo.

### Part J - Errors and held items

**Step 43. Open the Approval Queue.**
- Click: "Approval Queue" in the left menu (`components/sidebar.tsx:68`).
- You should see: the heading "Approval Queue". When nothing is waiting: "Nothing waiting". Below it, a section "Recently Sent".
- Expected result: `app/(dashboard)/approval/page.tsx:359` and `app/(dashboard)/approval/page.tsx:438`.

**Step 44. Show the Xero held documents (describe only).**
- Click: nothing. On the Integrations page, point at the section "Held for review (<n>)".
- You should see: the Xero documents waiting for an admin to approve.
- Expected result: `components/integrations/xero-held-review.tsx:53`. The text "Couldn't read the documents held for review. Nothing held is sent." is in the same area (grep result, file NOT VERIFIED). Whether this section appears on the demo server: NOT VERIFIED.

**Step 45. Show the e-mail history (describe only).**
- Click: nothing. The e-mail page is titled "Email & Payment Automation" (`app/(dashboard)/email/page.tsx`).
- You should see: statuses "Drafted", "Sending", "Sent", "Failed", "Needs checking" and "Sent manually" (`app/(dashboard)/email/page.tsx`).
- Expected result: status words are in code. How John reaches this page: NOT VERIFIED. It is not in the left menu (`components/sidebar.tsx:46-83`).

**Step 46. Show the Activity log (admin).**
- Click: "Activity" under "Resources" in the left menu (`components/sidebar.tsx:79`).
- You should see: the heading "Activity" (`app/(dashboard)/admin/activity/page.tsx`).
- Expected result: heading is in code. The entries: NOT VERIFIED - check on the day.

---

## 3. Do not show

Do not click or show these in the demo. They are OFF, unproven, or limited to test set-ups.

1. **Xero, live.** Real Xero sign-in, real transfers, real accountant link sign-in: NOT VERIFIED. The specs only check screens and an intercepted redirect (`tests/e2e/integrations-connect.spec.ts:498-499`).
2. **Microsoft 365, live.** Real connect and real mailbox sending: NOT VERIFIED. Do not click "Connect Microsoft 365".
3. **AI features.** OFF by default (`components/integrations/ai-setup-card.tsx:22`). Do not switch on, do not show the AI menu item unless the server has it on (`components/sidebar.tsx:50`).
4. **Xero "Turn on transfers".** OFF. Do not switch on (`components/integrations/xero-setup-card.tsx:91-93`).
5. **E-mail to a real customer.** Real delivery is NOT VERIFIED. The e-mail step runs against a mock (step 35).
6. **Resend test e-mail.** Not part of the demo (`components/integrations/resend-setup-card.tsx:92`).
7. **Platform owner pages** (the platform "Switch on" control for AI, `components/platform/tolra-ai-control.tsx:36`; app credentials). Not for John.
8. **Demo figures.** Money, counts and averages are placeholders and must not be quoted.
9. **Clock-in network lock.** There is a spec `tests/e2e/clock-in-network-lock.spec.ts`; it was not read for this script. Leave out unless it is checked first.
10. **Reopen, pause, despatch, RFQ and purchase orders.** Not in this script; they have specs but were not walked through here.
11. **Demo mode.** `NEXT_PUBLIC_DEMO_MODE=true` must not be on (section 1.2).
12. **Anything not on the sidebar** (e.g. `/email`, `/time/print`). Do not navigate by URL in front of John without checking first.

---

## 4. If something goes wrong

- **Sign-in is refused.** Check the username or email and password. Check the 6-digit code is current (it changes every 30 seconds). If the phone is lost, another admin resets the second step under Admin > Users (`app/mfa/page.tsx:163`).
- **A button is greyed out.** Usually a set-up state: Microsoft 365 and Xero "Not set up" (steps 37-38). Say so plainly; do not try to fix it in front of John.
- **Quote will not send: "date has passed".** Edit the quote and set a new "Valid until" date, then send (`tests/e2e/walkthrough.spec.ts:129-132`).
- **"Email now" is missing.** Either the user is Workshop or Viewer (`tests/e2e/email-one-click.spec.ts:95-97`), or demo mode is on (`app/(dashboard)/invoices/page.tsx:1693`). Switch to an Admin or Office user and check the flag.
- **Clock in and out or Save is missing with a note that the database needs updating.** The page shows that instead of the clock controls (`components/time/needs-update.tsx:3`). Stop the demo on this screen.
- **The booking button says "Book anyway".** The app is warning about the booking. Read the warning and say what it is; do not force it in front of John. Reason: NOT VERIFIED.
- **An e-mail shows "Failed" or "Needs checking".** Look at the e-mail page status (step 45) and the Approval Queue (step 43). Do not resend in front of John until it is understood.
- **A held Xero document appears.** Explain it is held for an admin (step 44). Do not approve it in the demo.
- **Anything else.** Stop, note the screen name and the exact message, and report it to Rhys. Do not guess.

---

## 5. NOT VERIFIED - check on the day

Every item below is marked NOT VERIFIED in the steps above or is outside what the repo asserts.

1. Step 1: which sign-in variant (dark or light) is shown.
2. Step 2: first-time admin authenticator set-up appears or not.
3. Step 3: where John lands after sign-in; whether "Choose a company" or "Choose Your View" appears.
4. Step 4: dashboard figures.
5. Step 8: whether a real e-mail leaves Tolra when a quote is sent.
6. Step 15: result of the created job after "Create job".
7. Step 17: the bench option's label when picking a machine.
8. Step 21: the figures for "Average job time".
9. Step 22: layout of the Machine Schedule chart.
10. Step 26: on-screen result after clocking in.
11. Step 27: placement of break buttons and their result.
12. Step 28: the entry shown after clocking out.
13. Step 29: the layout of the week and who can approve.
14. Step 30: the saved delivery note.
15. Step 34: the invoice status after saving a payment.
16. Step 35: a real mailbox receives the invoice e-mail (the spec uses a mock).
17. Step 37: Microsoft 365 connect in a set-up server, and everything after clicking Connect.
18. Step 38: the Xero card state on the demo server.
19. Step 39: the accountant receives the link; any Xero sign-in; any real Xero call.
20. Step 40: whether the authenticator prompt appears when the AI switch changes.
21. Step 41: the on-screen state of the Xero transfer switch.
22. Step 42: the Resend card state on the demo server.
23. Step 44: whether the Xero held-documents section appears on the demo server.
24. Step 45: how John reaches the e-mail page (not in the left menu).
25. Step 46: the Activity log entries.
26. Browser, device and screen size on the day.
27. Turning off real customer e-mail before the demo (how).
28. Which demo seed (job-u or codex) is used, and whether it has been run against the local database. Neither seed script is runnable from this worktree.

---

## 6. Approval

- Status: DRAFT - not approved.
- Approved by: not yet (Rhys).
- Date approved: not yet.
