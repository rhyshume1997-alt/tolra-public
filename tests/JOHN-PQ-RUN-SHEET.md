# John's eight checks

John, this is a practice run of a working day. You do the clicking. Code helps you set it up. Rhys makes the final decision.

Use a private test copy of **your real JNR records**, made by Code. Compare those records with your original SliQ reports. Do not change the live shop while practising. Any new trial work below belongs only in that copy. This sheet does not say the checks have passed.

## Before you start

Ask Code to sit with you and show you:

1. The test address. Ask: “Are you sure this is the copy, not our live shop?”
2. The JNR records copied from SliQ and the matching reports. Pick one customer, quote, job and unpaid invoice you know. Write their numbers below. Check the names, amounts and balances against SliQ before doing anything else.
3. Separate test logins for an admin, office worker, workshop worker and someone who can only look. Also a separate practice company. Nobody needs to lend you their password.
4. A test inbox that catches messages without sending them to customers. Automatic emails and real accounting connections must be off. Block external AI requests too; AI practice uses a controlled fake provider and trial inputs. Do not send this real-data copy or pasted customer details to Anthropic without the separate written AI-APPROVE decision. Code checks these boundaries before you click anything. Never point the synthetic automated suites at a copy containing real JNR records; they require their own fake-only backend.
5. The exact version being checked. Copy Code's version label below; you do not need to work out what it means.

If any of these is missing, stop and write **NOT RUN**. Do not tick Pass because Code says a test file exists.

| Write this down | Your answer |
| --- | --- |
| Your name and date | ____ |
| Test address and version label from Code | ____ |
| Date of the JNR copy and SliQ reports | ____ |
| Customer / quote / job / unpaid invoice numbers | ____ |
| Test inbox and separate practice company | ____ |

Keep notes and pictures in the private folder Code gives you. Do not put real customer details in GitHub. For each check, tick one box. If something is wrong, tick Fail, write what happened and stop that part. If you cannot do it, tick Not run. Never guess.

## 1. Each person sees only their own shop — PQ-001

**Click and look**

1. Sign in to the JNR copy. Open **Customers**, then **Invoicing**. Find the customer and invoice you wrote down. Compare the amount and amount still owed with SliQ.
2. Sign out. Sign in to the separate practice company. Search for the same JNR customer and invoice number. Code can give that company a different trial record with the same number, so compare the customer and amount too.
3. With Code, repeat using the office, workshop and look-only test logins. Try opening the settings and changing a trial invoice. Do not change an imported invoice. Code shows which actions each person should have.
4. Sign back in to JNR and check its original invoice is unchanged.

**You should see:** each shop's own records only. The other company cannot open JNR's invoice. A person who may only look cannot save a change. A hidden or refused action changes nothing.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

What happened / private picture or note name: ____  John / date: ____

## 2. A quote follows through with the right money — PQ-002

**Click and look**

1. Open **Quotes**. Read one copied JNR quote and compare its lines, VAT and total with the original. Leave that original record alone.
2. Have Code prepare a clearly named trial quote, using a typical JNR job and a safe test customer. Open it with **View**. Check quantity, price, customer order number, VAT and total. Include a part quantity and an awkward penny amount that Code has written down for you.
3. Compare the total with a separate calculation. For ordinary money, half a penny goes up: £0.135 becomes £0.14. Costing has a separate agreed rule; do not change its answers to force this check to pass.
4. On the trial quote only, use **Mark Accepted**, fill **Customer PO (optional)** if you have a trial order number, then **Confirm Accepted**. Open the job using **Open job**. Check the customer, order number and parts. There should be one job, not two.
5. Ask Code to show you that trial job's draft invoice in **Invoicing**. Open it and its print view. Compare the lines and totals again. Leave it as a draft. Ask Code to show that a draft cannot take a payment or add an issued debt.

**You should see:** the same work stays linked. Saved and printed money agrees to the penny. The draft is still a draft and no payment has appeared. The copied original JNR records stay unchanged.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Trial numbers / amounts / private evidence name: ____  John / date: ____

## 3. Hours, finished work and paperwork make sense — PQ-003

**Click and look**

1. Open a copied JNR job and its **Worksheet**. Compare the drawing number and work details with the paperwork you know. Leave the original unchanged.
2. Ask Code for a trial worker and trial job. Use the normal clock-in and clock-out buttons for that worker. Use the trial job's normal start, problem and finish actions, with Code helping where the screen asks for a choice.
3. On the finished trial job, choose **Reopen**, then cancel. Check nothing changed. Choose **Reopen** again, give a trial reason and finish the confirmation. Check the reason and the required approval or notice appear.
4. Tick that job on the job list. Click **Print Workshop Pack**. In **Print layout**, check both the ordinary layout and the JNR layout. Check the job, drawing, numbers and totals belong to that job.
5. Open **Weekly hours** and the hours settings with Code. Compare the agreed trial week with the timesheet. Code supplies five 08:00–16:00 days, 30 minutes lunch and a 15-minute break. Paid breaks should give 8:00 a day and 40:00 a week; unpaid breaks should give 7:15 and 36:15. Try these in separate trial companies; do not change JNR's unpaid setting to do the comparison.
6. As the admin test user, open **Activity**. Find who made the trial changes and when. Check the original JNR records still agree with your before notes.

**You should see:** hours agree with the saved break choice, both print layouts show the right work, cancelling does nothing, and reopening leaves a clear record.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Trial job / week / private evidence name: ____  John / date: ____

## 4. Switched-off extras stay off — PQ-004

**Click and look**

1. As the admin test user, open **Admin → Integrations**. With Code, check the assistant and accounting connections are off. Reload the page.
2. Try opening the assistant from the normal menu. Try the accounting action Code points out on a trial invoice.
3. For Xero only, ask Code to prepare a safe demo accounting account. With Code beside you, try the trial Xero export before the account choices are filled in. It should refuse. Sage and QuickBooks in this release provide balance checks, not invoice exports.
4. For Xero, let Code show you the account choices and the approval step. Stop before sending anything unless the named tester has approved that exact demo action. For Sage/QuickBooks, test that missing connection/setup blocks a balance check; do not look for an export action that is not provided.

**You should see:** off stays off. Missing setup or missing account choices stops the action. Nothing is emailed or exported just because you opened a screen or connected an account.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Private evidence name / who approved any practice send: ____  John / date: ____

## 5. Tell Rhys what worked and what did not — PQ-005

**Click and look**

1. Open this saved sheet and your private notes with Rhys. Go through every Pass, Fail and Not run box.
2. Ask Code to open the list in **tests/validation/TRACEABILITY.md**. Rhys checks that every promised job has a result and a saved note or report. John does not need to read program code.
3. Show any difference from SliQ, confusing words, missing button or wrong amount. Write it down even if someone offers a quick workaround.
4. Give Rhys your comments about using this for a normal day. Rhys completes the decision and signature in **tests/validation/VSR-TEMPLATE.md** using **tests/RHYS-SIGN-OFF-GUIDE.md** when it is included in the reviewed pack.

**You should see:** nothing has been hidden or called a pass without proof. Rhys records any remaining limit and makes the decision. John does not sign for Rhys. This check stays Not run until that review and decision actually happen.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Private review note / Rhys's decision record: ____  John / date: ____

## 6. A new shop starts empty; emails keep their words — PQ-006

**Click and look**

1. Ask Rhys and Code for a new, separate practice company. Do not use JNR or the demo company for this part.
2. Sign in as its admin. Open **Customers**, **Jobs**, **Quotes** and **Invoicing**. Look for your JNR invoice number. It must not be there. Its own setup activity is allowed.
3. Open the company setup guide in **Settings**. Follow its links in order. Save trial company details, a trial logo and its break choice. Tick only what you checked. Leave connections off; do not import any records.
4. Reload. Visit the guide on the people, integrations and import screens. The same saved ticks should appear. Recheck the empty business lists.
5. In **Settings**, open both the chase reminder and timesheet email templates. Use **Subject line**, **Greeting**, **Main message** and **Sign-off**. Add a name using **Add detail**. You should not have to type brackets. Watch the example change. Save and reload both.
6. Ask Code to load an old trial template with odd line breaks. Save it without editing. Code compares the stored words and spacing before and after. Try the screens as a look-only person and through Code's two help-access accounts. Those people must not save setup ticks; look-only people must not save templates. JNR's settings must be unchanged.

**You should see:** the new shop is empty, its own details and ticks stay saved, old email words stay exactly the same, and a preview sends no mail.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Practice company / private evidence name: ____  John / date: ____

## 7. A reminder sends only the approved words, once — PQ-007

**Click and look**

1. Ask Code for a clearly labelled trial overdue invoice in the JNR copy. Its address must lead only to the test inbox. Open **Invoicing**, make its chase draft, then open **Approvals**.
2. Choose **Edit**. Change the subject and add a final line, “John checked these words”. Save. Reopen it. Write the full recipient, subject and message in your private note, including line breaks.
3. Use **Approve and send**, read the confirmation and finish it. Try a quick second click if the screen allows it. Open the test inbox. Compare the whole message with your note. There must be exactly one.
4. Ask Code for a second trial draft open in two tabs. Review it in one. Change and save it in the other. Try the old approval. It must refuse and send nothing.
5. Ask Code to show the practice “not sure whether it sent” case. Trying again must not silently send another copy. Ask for the saved result; do not create a real delivery problem yourself.
6. Ask Code for two trial customers with the same name. The unclear match must refuse. Then ask Code to feed trial replies saying “paid”, “remittance” and “payment sent” into the test inbox. Reopen their trial invoices and compare amount paid and amount still owed with the before notes.

**You should see:** only the exact approved message sends, once, to the right person. Old or unclear approval refuses. An email saying “paid” never records a payment or changes the invoice balance by itself. If Code cannot show one of these parts, this whole check is Not run, not Pass.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Trial invoice / message count / private evidence name: ____  John / date: ____

## 8. The assistant and the three accounting accounts stay separate — PQ-008

**Click and look**

1. With Code, open **Admin → Integrations** in the JNR test copy. Use only the safe practice connections Code prepared. Never paste a real saved key into this sheet.
2. Try each assistant choice: the company's own account, then Tolra's account, then back. Ask a harmless trial question each time. Ask Code to show which practice account answered. A failed choice must not secretly use the other one. The other practice company must stay unchanged.
3. Rhys opens the allowance controls and completes his extra sign-in check. He checks the £10 starting allowance and £1,000 upper limit, then sets a small trial allowance for JNR only. An ordinary company admin, a help-access account and Rhys without the extra sign-in check must be refused. The other company must keep its allowance.
4. Ask Code for the saved test where two requests try to spend the last allowance at the same time. Together they must not go over the limit. Switching account choices must not reset what was used. A screen picture alone is not this proof.
5. In turn, open **Xero**, **Sage** and **QuickBooks**. With Code, check missing setup refuses; then connect each safe practice account. Check the right shop/account name. No saved secret should be shown. For Xero only, export must refuse before account choices are complete; any later demo export needs a named person's approval. For Sage and QuickBooks, check a trial invoice balance instead: these connections do not export invoices or mark them paid. A zero balance may reflect a credit, so check payment records before recording any payment.
6. Check the other practice company cannot see or use JNR's connections. As ordinary staff, try the restricted actions. They should refuse. With Code, disconnect Sage only: the other two must stay as they were. Then disconnect the other practice accounts separately. Compare the trial invoice's paid amount and balance again. Turn the assistant off at the end.

**You should see:** accounts, shops and results never get mixed. Only Rhys after the extra sign-in check changes Tolra's allowance. The limit holds. A connection, answer or accounting result never marks an invoice paid. Missing practice registration or a missing two-request report means Not run.

Result: [ ] PASS  [ ] FAIL  [ ] NOT RUN

Private account/check report names: ____  John / date: ____

## Give the sheet back

John's overall result: [ ] All eight passed  [ ] Something failed  [ ] Something not run

John's name / signature / date: ____

Give the sheet and private notes to Rhys and Code. Leave the assistant off and unused practice links cancelled. Keep the evidence. Do not delete imported records or reset document numbers to tidy up.

The current **tests/validation/PQ.md** also has **PQ-009**, the separate transfer-day check. These eight boxes do not complete it. Code and Rhys must retain its backup, data-transfer, money-comparison and go-or-stop results; see **tests/CUTOVER-DAY-CHECKLIST.md** when included in the reviewed pack. The official report still has nine planned PQ steps. No box on this sheet gives permission to start live work.

Source for Code: `tests/validation/PQ.md` PQ-001–PQ-008 and `tests/MANUAL-CHECKS-GO-LIVE.md` G01–G14, read at PR #284 head d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d. This adapts the practice checks to a private restored copy of John's real JNR data; it records no completed result and does not alter the official protocol.
