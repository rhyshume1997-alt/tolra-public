# Rhys's N1–N6 click checks

Use a disposable test copy with fake customers and a test mailbox. Ask Claude Code to prepare it using [the database handoff](BLOCKED-DATABASE-CHECKS.md). These checks have not been run against a database here. Do not connect a real customer's mailbox, accounting account or AI account for these checks.

Have two new test companies, Company A and Company B, a company admin for each, an office login, a viewer login and a read-only support login. Rhys also needs his own platform-owner login and authenticator. Keep one company's name and a made-up customer name clearly different from the other. Record pass/fail, the company, browser, date and any screenshot beside each item. Stop and report a failure; do not tick it as passed because a different test passed.

## N1 — paid or unpaid breaks (#218/#235; combined #236)

- [ ] Open Settings as the first company's admin. Find the working-hours and break settings.
- [ ] In Company A choose paid breaks. In Company B choose unpaid breaks, lunch 30 minutes, break 15 minutes and a six-hour threshold. Save both and reload: the two choices must stay different.
- [ ] Record the same test day, 09:00 to 17:00, in both companies. Company A must show 8 paid hours. Company B must show 7 hours 15 minutes: its saved rule deducts 45 minutes even if only a 30-minute break was clocked.
- [ ] Repeat for five working days. Working hours and the clocked timesheet must agree: Company A 40 paid hours, Company B 36 hours 15 minutes. Alternate A, B, B, A in separate tabs and reload; neither choice nor total may follow you between companies.
- [ ] Check the other company's break choice has not changed. Restore both companies' original settings.

## N2 — choose an AI account (#234, including #232 owner caps)

- [ ] Open Integrations before Rhys enables Tolra AI. There must be no Tolra-provided AI option. Your own-key choice must still work as before.
- [ ] As an ordinary company admin, try to open the platform controls. You must not be allowed to change Tolra's provider key or global switch.
- [ ] As Rhys, complete the authenticator step and open the platform page. The provider-key box must be blank, even if a key was saved earlier.
- [ ] In the test copy only, enter the synthetic test key supplied by Claude Code and switch Tolra AI on. The box must clear. Reload: it must still be blank, with no saved key or ending characters shown.
- [ ] Sign in as a company admin and open Integrations. Turn Tolra AI on for that company. Reload: the choice must remain on. There must be no card details, payments or plan-selection form.
- [ ] Open the other company: its choice and usage must be its own. Turning on the first company must not turn on the second.
- [ ] Ask Claude Code to fill the first company's test allowance. Try reading a made-up RFQ. It must refuse with a monthly-limit message and create no suggestion. The other company's allowance must stay unchanged.
- [ ] Turn Tolra AI off for the company. Requests must stop. As Rhys, switch the service off globally: companies must not silently start using their own keys instead.
- [ ] Try as an office user and a viewer: neither may change the company mode or the platform controls. No saved key may appear in an error.

## N3 — accounting connections (#221/#230; combined #237)

- [ ] Open Integrations. Find the Xero, Sage cloud and QuickBooks choices. Each must describe its actual connection state.
- [ ] With no provider app set up, check the screen explains why connecting is unavailable. It must not claim an account is connected.
- [ ] If Claude Code has supplied an approved provider sandbox, connect that sandbox only. Check the chosen company/account before exporting anything.
- [ ] Open the other company: it must not inherit the connection, account choice or saved credentials.
- [ ] Disconnect the sandbox. Reload: it must remain disconnected. Never use a live accounting account to get a tick here.

## N4 — validation pack (#220)

- [ ] Open `tests/validation/README.md` and follow the pack's own order. Record the version tested.
- [ ] Check each requirement has a check and evidence. Mark missing evidence as not run, with the reason.
- [ ] Put actual results in a copy of the validation report template. A passing file check is not proof that browser or database checks ran.

## N5 — blank-company setup (#222)

- [ ] Sign in to a new company. Customers, jobs, quotes and invoices must start empty. No other company's name, customer, logo or records may appear.
- [ ] Open Settings. Find the company setup guide: company details; logo and colours; working hours; breaks; people and roles; accounting; AI; email; import.
- [ ] Follow each link. The guide must stay available on Settings, Users, Integrations and Import. Import must be the last step.
- [ ] Enter only the test company's own details. Check the logo/colours and working hours, including N1's break choice.
- [ ] Tick “I have checked this” for one step. Move to Users, then Integrations, then Import. The tick must stay. Reload: it must still be there.
- [ ] Untick the step and reload: it must stay unticked. Collapse and reopen the guide: no work should be lost.
- [ ] Sign out and enter the other company. Its progress and records must be separate. No first-company tick may appear.
- [ ] Leave optional connections off and do not import anything. The company must remain usable and empty; reviewing setup must not add sample records.

## N6 — email wording without typing markers (#223)

- [ ] Open Settings → Email templates. Find the invoice reminder and weekly timesheet templates.
- [ ] For each, find Subject line, Greeting, Main message and Sign-off. Each must have a short hint.
- [ ] Write a greeting and sign-off slowly, one letter at a time. The text must stay in the box you are typing in.
- [ ] Use the detail list and Add detail button for a customer/contact name, amount, due date, document number or job where the template offers it. Do not type brackets. The preview must show example details immediately.
- [ ] Edit the message without saving. Reload: unsaved wording must not replace the saved template.
- [ ] Edit and save. Reload: the saved wording and inserted details must still work. Reset to default and reload: the original wording must return.
- [ ] Ask Claude Code to load an old saved template, including one with an unknown marker. Its text must survive; an unknown marker must stay visible with a warning rather than disappear.
- [ ] Keep a draft waiting for approval. Change the template. Reopen that draft: its reviewed subject and body must not have changed. A template edit must never approve or send it.
- [ ] For a chase draft in the test mailbox, change its text after someone has reviewed it. Approval of the stale text must be refused; review and approve the current exact text before sending. Check only one test email is sent.
- [ ] Try an office login and a viewer login. Settings must retain its current access rules; the new editor must not let a forbidden login save changes.

## Record the outcome

- [ ] Attach the CI run links, exact pass/fail/skip totals, screenshots and any remaining failures to the draft PRs. Keep database/provider checks marked blocked until their own evidence exists.
- [ ] Restore the test settings and remove fake data using the test harness. Do not apply production SQL, deploy, merge or add a Ready label as part of this checklist.


## P-AI — Rhys sets each company's Tolra-provided AI allowance (#232/#234)

Use fake companies and a mock AI provider. This is Tolra-provided AI, not the company's own-key monthly limit. No real provider key or spending is needed. The default is 1,000p (£10) per company per month; the maximum is 100,000p (£1,000).

- [ ] Sign in as Rhys, pass the authenticator step and open Platform → Company AI limits. Find A and B by name. Their limits, used amounts and reserved amounts must be shown separately.
- [ ] In “Monthly AI limit for Company A (pence)” enter 1500 and press “Save limit for Company A”. Reload. A must show 1500p (£15); B must keep its previous limit. Change B to 2000p (£20); reload and check A is still 1500p.
- [ ] Try -1, a fraction of a penny and 100001. Each must be refused, with the saved limits unchanged. Do not raise a limit to get a failing test to pass.
- [ ] Ask Code to put fake used/reserved amounts into the approved test fixture. Try a limit below that total: it must be refused. Setting the limit equal to used plus reserved must stop further requests, not erase earlier usage.
- [ ] Sign in as A's company admin, then office, viewer and read-only support. None may open or use Rhys's cap controls. Ask Code to repeat the direct cap request under each identity: it must be refused, leaving both A and B unchanged.
- [ ] As A's admin change A's company AI mode. B's mode and cap must stay unchanged. Ask Code to submit B's company ID in A's mode request: it must not change B. Switching companies must not reset usage.
- [ ] On the provider-key screen save only Code's synthetic test key. The box must clear. Reload and visit each company's Integrations screen. Neither the key nor an encrypted copy may appear in the page, status answer, save answer or error answer. Ask Code to inspect the browser responses without copying secrets into evidence.
- [ ] Ask Code to prepare the near-limit fixture: a 15p allowance remaining and two 10p requests. Start the requests together in two tabs. Only one may reserve/run; the other must get the limit refusal. No overspend, negative reservation or second provider call is allowed. B must remain unchanged.
- [ ] The two-tab click is not proof of a database race. Ask Code to run the existing `tests/db/tolra-ai-cap-concurrency.test.ts` on the separately approved disposable backend: it holds the ledger lock and uses two independent connections. Attach that result too; until then mark the real race check NOT RUN.

## P-CHASE — approval and uncertain delivery (#233)

Use a fake invoice, fake recipient and mock mailbox. Code must supply clear-success and unknown-delivery responses; never send a real reminder just to test a failure.

- [ ] Open a reminder awaiting approval. Save its exact subject and message in the private test evidence, including paragraphs and punctuation. Approve and send: the mock mailbox must contain that exact text, once.
- [ ] Review another draft, then edit and save its text before sending. Sending with the old approval must be refused. Review the new text before sending; only the new, exactly approved text may arrive.
- [ ] With the mock mailbox paused, click Send twice, or use two tabs on the same draft. Release the mock response. There must be one delivered email and one successful send record.
- [ ] Make the mock mailbox answer “unknown whether delivered”. The draft must become “needs checking”. Reload, double-click again and run the normal reminder check. No second email may be attempted automatically. A person must check the mailbox before any resolution.

## P-ACCOUNTING — encrypted, separate connections (#221/#230/#237)

- [ ] In Company A connect the approved Sage sandbox and QuickBooks sandbox separately. Check that each card names the correct business. Keep Xero's mappings/send checks separate; the new adapters do not send invoices.
- [ ] Give Code the two fake invoice cases with the same invoice number in different companies/providers. Check each from its own company. The balance must come from that company and provider only; checking Sage must not use a QuickBooks token or business.
- [ ] As Company B open Integrations and try to check A's invoice. A's connection details and balance must not be returned. Code should also try A's company/tenant/invoice IDs in B's direct request: no crossing is allowed.
- [ ] Ask Code to inspect only the test database's stored tokens. Every saved/rotated token must be encrypted, not a readable access or refresh token. Decrypting with another company or provider must fail. No token may appear in browser responses or evidence screenshots.
- [ ] Ask Code to force a fake token refresh and repeat the two-provider checks. Each provider must keep its own rotated tokens. A failed connection check must not mark any invoice paid or silently try the other provider.
- [ ] Record R's database replay check separately: the corrected 144 preserves 084's body guard. The two reported labour/network DB failures and the full schema replay still need an actual clean disposable-database run; unit passes do not close that condition.

## P-SETUP — progress belongs to that company's own admins (#222/#236)

- [ ] As A's own admin tick one setup step and reload. As B's own admin, that A tick must not appear; ticking B must not change A.
- [ ] Sign in as office, workshop, viewer and read-only support. None may read A's or B's saved progress rows, even by asking the data endpoint directly. None may insert or update them. Ask Code to record the denied requests. A general help link is not permission to see saved ticks.
- [ ] Return as each own-company admin. Its saved progress must be unchanged by those attempts. Customers, quotes, jobs and invoices must still contain only that company's own records.

## P-EMAIL — preserve saved wording and permissions (#223/#233/#236)

- [ ] Have Code supply an old saved template with spaces, line breaks and an unknown detail marker. Open it, change nothing and save/reopen. The subject and body must be identical, character for character; the unknown marker stays visible with its warning.
- [ ] As a read-only identity try typing, adding a detail and saving. The editor must not allow a save. Code must repeat the save request directly and record refusal; hiding a button alone is not proof of permissions.
- [ ] Changing a saved template must not rewrite an already reviewed draft. Repeat P-CHASE with the draft's own edited subject and body; approval must still apply to the exact text sent.

## Evidence for every reviewer condition

For each section above record: exact tested commit and PR, fake company/role, expected result, actual result, PASS / FAIL / NOT RUN, date, screenshot or log link. Store completed evidence privately. A click checklist, mocked unit test, SQL-file check or collected browser case does not prove a database policy, encrypted storage at runtime, genuine concurrency or real provider behaviour.

No SQL, deployment, provider registration or test data change is performed by this document. The N2/N5 proposals and numbered 144 require their own review before a database owner prepares a disposable test copy. Stop on any failure; keep the reviewer condition open until its own evidence passes.

## V — remaining reviewer checks in Playwright

Use the separately prepared disposable application/database described in `tests/e2e/reviewer/README.md`. No database means ten explicit skips, not ten passes. A configured but broken schema or missing feature must fail. Ask Code to run the required-backend command and attach actual results; keep this table NOT RUN until then.

| Case | Plain click/API check and expected result | Pass / Fail / Not run; evidence |
| --- | --- | --- |
| V-ACCOUNTING | Connect the two fake providers for A. Saved tokens are encrypted and cannot decrypt for B or the other provider. The correct provider returns its own balance; B sees no A connection/balance. Nothing marks an invoice paid. | NOT RUN; ____ |
| V-AI-CAPS | Rhys passes MFA, changes A's cap, reloads and checks B stayed unchanged. A's company admin cannot read/write platform caps or change B's AI mode. | NOT RUN; ____ |
| V-SETUP-SUPPORT | Enter a fake company as read-only support, then request logged write access. Neither support state may see or change its saved setup ticks; the own admin's tick stays. | NOT RUN; ____ |
| V-CHASE-EDIT | Review a reminder, save an edit, try the old approval and require refusal. Approve the edited text; exactly that subject/message arrives once. | NOT RUN; ____ |
| V-CHASE-DOUBLE | Start two Sends together. One succeeds, the other refuses; the fake mailbox contains one exact approved email. | NOT RUN; ____ |
| V-CHASE-UNKNOWN | The fake mailbox receives one email but answers unknown. The draft needs checking; reload and retry three times. No second provider send is allowed. | NOT RUN; ____ |
| V-INBOUND | Receive fake Paid, Remittance and Payment sent replies through the real intake procedure. Keep evidence, but invoice status, paid amount/date and payment ledger must not change. | NOT RUN; ____ |
| V-BREAKS | Keep paid and unpaid companies open side by side with the same five eight-hour days. Settings and actual timesheets agree at 40:00 versus 36:15 and stay separate after reload. | NOT RUN; ____ |
| V-SETUP-ROLES | Office, workshop and viewer try to read/write saved setup rows. Each is refused/gets no rows; the own admin's original tick remains visible and unchanged. | NOT RUN; ____ |
| V-EMAIL-LEGACY | Reopen old saved wording, spaces and an unknown marker unchanged. Read-only users' direct save requests are refused; stored text stays exact. | NOT RUN; ____ |
