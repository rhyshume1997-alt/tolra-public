# Rhys's N1–N6 click checks

Use a disposable test copy with fake customers and a test mailbox. Ask Claude Code to prepare it using [the database handoff](BLOCKED-DATABASE-CHECKS.md). These checks have not been run against a database here. Do not connect a real customer's mailbox, accounting account or AI account for these checks.

Have two new test companies, a company admin, an office login and a viewer login. Keep one company's name and a made-up customer name clearly different from the other. Record pass/fail, the company, browser, date and any screenshot beside each item. Stop and report a failure; do not tick it as passed because a different test passed.

## N1 — paid or unpaid breaks (#218)

- [ ] Open Settings as the first company's admin. Find the working-hours and break settings.
- [ ] Choose unpaid breaks and save. Reload the page: it must still say unpaid.
- [ ] Record a test day from 09:00 to 17:00 with a 30-minute break. It must count 7 hours 30 minutes of paid work.
- [ ] Change the company to paid breaks, save and repeat that day. It must count 8 hours of paid work.
- [ ] Check the other company's break choice has not changed. Restore both companies' original settings.

## N2 — choose an AI account (#219 and #224)

- [ ] Open Integrations before Rhys enables Tolra AI. There must be no Tolra-provided AI option. Your own-key choice must still work as before.
- [ ] As an ordinary company admin, try to open the platform controls. You must not be allowed to change Tolra's provider key or global switch.
- [ ] As Rhys, complete the authenticator step and open the platform page. The provider-key box must be blank, even if a key was saved earlier.
- [ ] In the test copy only, enter the synthetic test key supplied by Claude Code and switch Tolra AI on. The box must clear. Reload: it must still be blank, with no saved key or ending characters shown.
- [ ] Sign in as a company admin and open Integrations. Turn Tolra AI on for that company. Reload: the choice must remain on. There must be no card details, payments or plan-selection form.
- [ ] Open the other company: its choice and usage must be its own. Turning on the first company must not turn on the second.
- [ ] Ask Claude Code to fill the first company's test allowance. Try reading a made-up RFQ. It must refuse with a monthly-limit message and create no suggestion. The other company's allowance must stay unchanged.
- [ ] Turn Tolra AI off for the company. Requests must stop. As Rhys, switch the service off globally: companies must not silently start using their own keys instead.
- [ ] Try as an office user and a viewer: neither may change the company mode or the platform controls. No saved key may appear in an error.

## N3 — accounting connections (#221)

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
