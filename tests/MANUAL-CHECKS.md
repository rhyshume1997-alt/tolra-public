# Manual checks for Rhys

Use a test company and made-up customers. Use an email address you control. These are checks to do after Claude has joined the code and prepared the test database. Do not use JNR's live invoices or send a real customer a reminder.

Write PASS, FAIL or BLOCKED beside each check, with the date, person and a short note. If a button or page is missing, write BLOCKED. Do not change a database to make the check pass.

Before starting, ask Claude to prepare: two test companies, an admin, an office user, an ordinary staff user and a support session; an unpaid invoice due yesterday; a second unpaid invoice; a paid invoice; and a customer email address you control. Ask Claude to turn on test email delivery. Keep the test inbox open.

## Payment chasing

1. Sign in as the admin or office user. Open Settings and find payment chasing.
   Expected: it says reminders are drafts for approval. Saving settings must not send an email.
2. Add a row for 3 days before the due date: enter -3 and choose the before-due tone. Add rows for 7 days (friendly), 14 days (firm) and 30 days (final).
   Expected: each day and tone stays in its own row.
3. Remove a row, add it again, then save and reload the page.
   Expected: all saved rows come back correctly. No half-saved list and no email.
4. Try two rows with the same day, a day outside the allowed range, and a before-due day with a late-payment tone.
   Expected: clear help, no save, and the previous settings stay unchanged.
5. Open the same settings in two tabs. Save a change in tab one. Try a different change in tab two without reloading it.
   Expected: tab two asks you to reload. It must not silently replace tab one's changes.
6. In the test company, use the invoice page's action to make overdue chase drafts. Open Approvals.
   Expected: the unpaid invoice has a draft. The paid invoice does not. Nothing has reached the inbox yet.
7. Open a draft, choose Edit, change its message and save it. Read the saved message, then choose Approve and send.
   Expected: one email reaches the test inbox, with exactly the saved subject and message you read. The draft leaves the waiting list.
8. Open the same draft in two tabs before sending. Edit and save it in one tab. Try Approve and send from the old view in the other.
   Expected: the old view refuses and asks you to reload and review. It must not send the new message under an old approval.
9. Try a double click on Approve and send in a fresh draft.
   Expected: one email, not two. While sending, the draft cannot be edited. If the result is unclear, stop and ask Claude to check the inbox/history; do not send it again.
10. On another draft choose Skip, then reload.
    Expected: it is held for the stated time and no email is sent. It may still be visible with a held/skipped explanation; it must not be sent by another pass.
11. Choose Pause chasing for this customer. Ask Claude to run another test pass.
    Expected: no new chase for that customer's invoices. A different customer's invoice can still be chased.
12. Switch to the other company, then try ordinary staff and support access.
    Expected: no first-company drafts/settings leak into the second company. Ordinary staff and support cannot save or send.

## Bank check

If there is no Bank check screen in the joined app, mark these checks BLOCKED: the parent-page connection is still needed. A standalone component or parser test is not a working bank screen.

1. Open Bank check and select a made-up CSV with Date, Description and Amount columns. Include two money-in rows with exact invoice references and amounts, and one money-out row.
   Expected: amounts are shown in pounds and pence. Money out is not suggested as an invoice payment. No invoice is paid just by opening the CSV.
2. Use a row for INV-123 when INV-12 also exists, with the same customer name.
   Expected: INV-12 is never chosen just because it is the start of INV-123.
3. Try a CSV containing a pound sign and a quoted thousands amount, such as £1,234.56. Try a named date such as 2 November 2026 and a normal UK date such as 02/11/2026.
   Expected: both dates mean 2 November; the amount is £1,234.56, not £123,456 or £1.23.
4. Try an unfinished quote, an impossible date, a blank amount, a non-pound currency, and a row with both money in and money out.
   Expected: an error. Confirmation is blocked while errors remain. No partial automatic posting.
5. Confirm one correct suggested payment.
   Expected: the button waits for success, the invoice balance changes once, and reloading shows the same payment.
6. Ask Claude to make one test confirmation fail. Try again after it is fixed, using the same file and row.
   Expected: the failed row stays visible with an error; it is not hidden as paid. The retry records one payment at most.
7. Do not assume that a different bank export knows a payment was already imported.
   Expected: mark cross-file duplicate protection BLOCKED until Claude has joined a lasting transaction reference. Do not confirm the same real payment twice.

## Costing

1. Open Settings and find costing. Set material Steel to £10 each, waste 0%, company labour £30 an hour, other running costs 0%, and add-on percentage 20%. Use a test machine with no making/setup time for the simple price check.
   Expected: rates save together and are still correct after reload.
2. Try saving a money value of 1.005 in each money field in turn.
   Expected: it asks for pounds and pence with at most two decimal places. Nothing is partly saved.
3. Change a material, a machine and a default rate together. Ask Claude to make the save fail during the test, then reload.
   Expected: either the whole old set or the whole new set is shown after the outcome is checked, never a mixture. A lost connection alone does not prove whether a save completed.
4. Use two tabs to change the same rates.
   Expected: a stale tab asks you to reload before saving; no silent overwrite.
5. Open a test quote and choose Price this part. Select Steel, quantity 3, and set all time fields to zero.
   Expected: cost £10 per part, price £12 per part, quote line total £36 before VAT. Add it to the quote: quantity, unit price and total agree with the preview.
6. Enter quantity 0 and then 1.5.
   Expected: a helpful message, no crash and no quote line until quantity is a valid whole number.
7. Ask Claude to prepare one machine with labour £12 an hour and another with labour £0, while company labour is £30. Use one hour making time, no setup/programming time, no other running costs or add-on, zero material cost and zero machine charge.
   Expected: labour shows £12 for the first machine and £0 for the second. Reloading/saving other settings must not turn either into £30. A machine with no override should use £30.
8. Switch companies and try ordinary staff or support access.
   Expected: rates do not leak between companies, and users without permission cannot save.

## Timesheet emails

1. Open Settings as an admin. Find timesheet emails. Choose Monday and Friday, 09:00, and your test inbox address. Save and reload.
   Expected: both chosen days, time and address stay saved. The next-send text agrees with the chosen days.
2. Remove all days, then try an invalid time or email address.
   Expected: a clear message and no invalid save.
3. Remove every recipient and save.
   Expected: a clear refusal or an explicit off/not-ready state; no message is sent to a guessed or old address.
4. Ask Claude to run the test clock just before and just after Monday 09:00.
   Expected: no early email; one email when due. Its hours and dates belong to the test company.
5. Ask Claude to run the same due pass twice.
   Expected: one email, not two.
6. Ask Claude to use test dates around the March and October clock changes in Europe/London.
   Expected: 09:00 remains 09:00 local time. There is no missing day or duplicate email.
7. Turn the schedule off, save and reload; ask for another due pass.
   Expected: no email. Ordinary staff and support cannot change the schedule.

## Customer says paid

1. Open the unpaid test invoice and choose Customer says paid.
   Expected: Payment to confirm appears. The invoice is not marked paid and its balance is not changed.
2. Ask Claude to run a chase pass.
   Expected: no new chase while that payment claim is open.
3. Choose Confirm payment received, then cancel the payment form. Choose it again.
   Expected: the form opens again. Cancelling did not record money or permanently lock the button.
4. Complete the payment form with the amount actually received in the test. Reload.
   Expected: the payment is recorded once, the balance is correct, and the claim banner clears after confirmation.
5. On a different unpaid test invoice, choose Customer says paid, then Not received, resume chasing.
   Expected: no payment is invented. The claim clears and chasing can resume under the saved steps.
6. Ask Claude to feed made-up emails through the test inbox: a real matching sender saying BACS sent for INV-123; a missing sender; a fake display name containing the customer's email with a different real address; a similar domain; and will pay next week.
   Expected: only a clear completed-payment claim from the actual matching mailbox is suggested for review. Nothing is automatically marked paid. Case differences may match; plus-addresses must match exactly. A sender string alone is not proof an email is authentic.
7. Try an ordinary staff user, support access and another company.
   Expected: no unauthorised payment confirmation, claim changes or other-company data.

## Finish

Record the app version, test company, person, date and each PASS/FAIL/BLOCKED result. Keep screenshots free of real customer or staff details. Send failures and blocked checks to Rhys and Claude for the go-live decision. These written steps are not evidence that the checks have been run.
