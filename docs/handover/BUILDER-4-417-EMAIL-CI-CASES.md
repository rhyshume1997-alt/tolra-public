# PR #417: run the six database checks and the 16 browser cases

Use the latest pushed head of `codex/b4-415-email-mfa-review`, not #415 or another agent's branch. These are the existing tests and workflow; no replacement workflow or manual seed is needed. All addresses below end in `example.test`. They must reach the mock mail service only.

## Backend setup and the cause of the six failures

All six cases in `tests/db/reviewer-chase-conditions.test.ts` failed at `verifyBackendIdentity()` because `TEST_SUPABASE_URL` was absent. No SQL or email was attempted. The helper had not completed, so it had not written `.env.test.local`.

The local CLI used a different default image registry from CI. CI uses Supabase CLI **2.108.0**, and `supabase/setup-cli@v1` selects the official **ghcr.io** images. A plain local CLI tried `public.ecr.aws`, which this worker's network policy refused. `scripts/test-backend.sh` now uses CI's official registry by default and honours an explicit `SUPABASE_INTERNAL_IMAGE_REGISTRY`; it never silently retries through another registry.

A controlled CI run also exposed a separate startup failure already present on #415: CLI 2.40.7 treats the `_atomic` suffix in `save_costing_settings_atomic` as the `BEGIN ATOMIC` keyword and combines separate commands into one prepared statement (`SQLSTATE 42601`, migration 143 statement 9). The upstream 2.108.0 parser's `isBeginAtomic` checks identifier boundaries and the preceding BEGIN. CI is now pinned to **2.108.0**, and the backend helper refuses the old version before startup. The numbered migration, its checksum and Code's costing implementation are unchanged. Upstream reference: `supabase/cli`, tag `v2.108.0`, `apps/cli-go/pkg/parser/state.go`.

With the CI-matched CLI and registry the download succeeded. Extraction then failed with **no space left on device** on this worker's 8 GB disk. Removing 2.2 GB of this builder's generated build files left 4.2 GB free; a second extraction still filled the disk and failed. Docker removed the incomplete pull; there is no running backend. A worker with more disk (request: at least 20 GB) or a pre-existing disposable local stack is needed here. Do not remove someone else's files, change Docker's storage driver, weaken the identity guard, invent connection settings, or substitute a hosted database.

On a runner with Docker, sufficient disk and the CI-pinned CLI:

```sh
supabase --version                       # expected: 2.108.0
npm ci
npm run test:backend                     # expected: local services healthy, .env.test.local written
mkdir -p evidence
npx vitest run -c vitest.db.config.ts tests/db/reviewer-chase-conditions.test.ts \
  --reporter=verbose --reporter=json --outputFile.json=evidence/email-db.json
node scripts/ci-evidence.mjs vitest-summary evidence/email-db.json EMAIL_DB
```

Expected database result: **6 passed, 0 failed, 0 skipped**. The tests themselves read `.env.test.local`; do not paste its keys into logs or PR comments. Startup must report loopback coordinates. A partial/hosted setting or an existing non-synthetic company must still stop the tests. `SUPABASE_BIN=/path/to/supabase npm run test:backend` is supported for a locally installed CLI.

The six checks create their own two synthetic companies and users, then clean them up. They cover: exact reviewed text plus concurrent/unknown holds; editing invalidates approval; a payment claim is not a receipt; duplicate approval sends once; cross-company creation/approval/claim refusal; and changing the recipient invalidates approval. Delivery is mocked; the database and RLS are real.

## Use the existing CI job

The workflow is `.github/workflows/ci.yml` (`CI`). On a code PR its `integration` job is gated by the existing `ready` label. Alternatively, an authorised maintainer can choose **Actions → CI → Run workflow**, select this codex branch and supply:

- `specs`: `tests/e2e/chase-steps.spec.ts tests/e2e/chasing-controls.spec.ts tests/e2e/email-schedules.spec.ts`
- `skip_db`: `false` — keeps the full database suite (including the six checks) and upgrade rehearsal. Choosing `true` omits those proofs.

Equivalent existing-workflow command:

```sh
gh workflow run ci.yml --ref codex/b4-415-email-mfa-review \
  -f specs='tests/e2e/chase-steps.spec.ts tests/e2e/chasing-controls.spec.ts tests/e2e/email-schedules.spec.ts' \
  -f skip_db=false
```

This does not merge or deploy. The job already reserves local ports, signs in to GHCR with its read-only Actions token, starts the disposable stack, runs database checks/rehearsal, builds against that stack and installs/verifies the existing one-time test releases 145, 146, 147, 149 and 150. Keep those steps and their markers in their existing order. Do not reset the database between release installation and browser tests, or apply those files to production. It also runs the separate reviewer suite and its existing evidence check.

At the existing **Browser suite** step, after those prerequisites, the exact targeted command and optional stricter count check are:

```sh
mkdir -p evidence
PLAYWRIGHT_JSON_OUTPUT_NAME=evidence/email-browser.json E2E_SKIP_BUILD=1 \
  npx playwright test tests/e2e/chase-steps.spec.ts tests/e2e/chasing-controls.spec.ts \
  tests/e2e/email-schedules.spec.ts --workers=1 --reporter=list,json
node scripts/ci-evidence.mjs playwright evidence/email-browser.json 16
```

Expected: **16 passed, 0 failed, 0 skipped**. Existing default Playwright global setup must run. Do not use an optional runner to turn missing setup into green skips. For collection only, append `--list`: expected **16 tests in 3 files**; collection is not execution. Outside the prebuilt CI step, omit `E2E_SKIP_BUILD=1` so Playwright builds against the supplied local backend. If running locally, also complete the existing release-install/verify prerequisites described above before the browser run.

## Shared browser data and services

`tests/e2e/global-setup.ts` proves that the API/database are local and every existing company has a synthetic `t-` slug. It creates an alpha and beta company with admin, office, workshop and viewer accounts through the existing fixtures. Passwords and run IDs are generated; `tests/e2e/helpers.ts` signs in through the real form and gives each browser session a separate test device address. Never substitute Rhys, John, JNR, Marpet or customer logins.

The app is built against the local anon URL/key, and Playwright starts its own app on port 3001, plus the existing MFA server on 3002. The mock mail service is on 3999; `GET /__emails` records provider payloads. The test app uses `RESEND_API_KEY=re_test_mock`, `RESEND_BASE_URL=http://127.0.0.1:3999`, `EMAIL_FROM=Tolra Test <noreply@example.test>` and the test-only cron secret from `tests/e2e/paths.ts`. The outbound guard remains loaded. None of these 16 cases needs a real Microsoft/Resend account, a human authenticator, real email or a browser left open overnight.

Global setup installs the existing, reviewed atomic chase-save proposal only after verifying the disposable backend. It checks the function hash/permissions and waits for the API schema cache. Do not bypass that fixture by inserting a different function. Teardown checks that synthetic company data is gone and the outbound-block log is empty. Keep `world.json` (generated test passwords) out of uploaded artifacts; the existing workflow already excludes it.

Run each whole file. The four `chase-steps` cases and the five company-specific `email-schedules` cases share serial state; running only their final case with `--grep` omits required earlier steps.

## Cases 1–4: `tests/e2e/chase-steps.spec.ts`

Shared data: a fresh solo company `t-<run>-chase-<tag>`, its admin, customer `Chase <tag> Ltd`, contact Pat and address `chase.<tag>.<run>@example.test`. Three issued invoices have subtotal £100, VAT £20, total £120, and due date **today in Europe/London + 3 days**. References are `INV-CH-<tag>-owed`, `-paused`, `-paid`. The paid row starts paid with £120 received; the other two start sent with £0 received. Start with no saved chase steps or schedules.

1. **Suggested steps and save.** Sign in as the solo admin; go to `/settings`. Find `getByTestId('chase-steps')`; expect the suggested notice and four `chase-step` rows. Confirm no stored steps. Click **Save chase steps** and wait for POST `/rpc/save_chase_steps_atomic` to return 200. Expect success and the stored steps `-3/before_due`, `7/friendly`, `14/firm`, `30/final`.
2. **Pause, resume, pause.** Open `/invoices?invoice=<paused ID>`. In `chase-pause-invoice`, choose **Pause chasing**, enter reason **Query on the delivery**, then **Pause**. Expect **Chasing paused** and that reason stored with the admin ID. **Resume chasing** must remove the row. Pause again with **On hold**, close the details and expect the invoice list's `chase-paused-badge`.
3. **Scheduled drafts only.** Insert this company's enabled once-only `invoice_reminder` schedule with `run_at=now+3 seconds`, `time_of_day=08:00`; wait 4 seconds. Record mock mailbox count. GET `/api/cron/daily` with `Authorization: Bearer <E2E_CRON_SECRET>`. Expect 200, no email-schedule error, exactly one `drafted` history row addressed to this customer for the owed invoice, and one `chase_sends` row at offset -3, tone before_due, drafted_by null. No paid/paused invoice draft and no new mock email.
4. **Save edits, review, send exactly once.** Open `/approval`; find the card containing the generated address. Click **Edit**. Read the subject and append `\n\nEdited before sending <tag>` to the body. **Save draft**; expect the editor to close and the exact saved subject/body in the database. Click **Approve and send**; if the review dialog appears, verify the same values and confirm once. Expect POST `/api/chase/approve` 200, no remaining approval button and exactly one matching mock email with that exact subject/body. `chase_sends` must record sent, approved_by=admin, sent_history_id and no draft_history_id. Reload: it stays off the queue.

## Cases 5–9: `tests/e2e/chasing-controls.spec.ts`

Each case gets a **new** solo company/admin `t-<run>-chase-ui-<tag>`, customer `Chase UI <tag>` at `chase.<tag>@example.test`, invoice `INV-UI-<tag>` (sent, £100 + £20 VAT = £120, £0 received, due 2026-01-01), and a saved 7-day friendly step. Do not share this invoice between the five cases. For cases 6–7, the helper opens `/invoices`, clicks **Chase All Overdue**, waits for one `chase_sends` row, then opens `/approval`.

5. **Edit/save/reload settings.** `/settings` → form **Payment chasing settings**. Set **Days from due date — step 1** to `10` and **Tone — step 1** to `firm`; click **Save chase steps**. Expect **Chase steps saved.** Reload and expect 10/firm both on screen and in `chase_steps`.
6. **Skip keeps the draft.** Generate the draft with the helper above; click **Skip**. Expect no **Approve and send** button. History stays `drafted`, with `skipped_until` later than now. No delivery is needed.
7. **Customer pause blocks sending.** Generate the draft; click **Pause chasing for this customer**. Expect a `chase_pauses` row for this customer. Click **Approve and send**. Expect **Chasing is paused for this customer. Resume it first.** and a chase row still drafted; no send.
8. **Claim is not payment.** Open `/invoices?invoice=<ID>`; click **Customer says paid**. Expect **Payment to confirm** and £0 received. Click **Not received, resume chasing**. Expect no claim, £0 received, status sent and the **Customer says paid** button enabled again.
9. **Cancel does not pay; saving a receipt does.** Open the invoice and choose **Customer says paid** → **Confirm payment received**. In **Record a payment on INV-UI-<tag>**, click **Cancel**. Claim remains and received stays £0. Reload; choose **Confirm payment received** again, fill **Amount received (£)** with `120.00`, click **Save payment**. Expect claim cleared, received £120, status paid, and exactly one £120 `invoice_payments` row.

## Cases 10–16: `tests/e2e/email-schedules.spec.ts`

10. **Office cannot open Settings.** Use global alpha's office account. Sign in, go to `/settings`; expect redirect to `/dashboard`, no `email-schedules-card` and no **Email schedules** heading. No schedule seed needed.
11. **Workshop cannot open Settings.** Repeat case 10 with global alpha's workshop account. Expect the same refusal.

Cases 12–16 share a fresh solo company/admin `t-<run>-sched-<tag>` with no schedule rows initially. Selectors are `email-schedules-card`, `email-schedule-invoice_reminder`, `email-schedule-timesheet`; field IDs follow `#email-schedule-<kind>-frequency|weekday|date|time|recipients`.

12. **Both switches start off.** `/settings`: both invoice reminder and timesheet switches have `aria-checked=false`, both next-run lines say **Off: nothing will be sent.**, save buttons are enabled for admin and the database has no schedules. The card explains the next daily run is about 05:00 UK.
13. **Weekly invoice reminders persist.** Turn Invoice reminders on. Choose **Every week**, **Wednesday**, time `10:30`; **Save Invoice reminders**. Expect one row: enabled, frequency weekly, weekday 3, timezone Europe/London, no fixed recipients, no run_at/last_run_at; time 10:30. Timesheets still have no row. Preview names Wednesday 10:30 GMT/BST and the next daily 05:00/06:00 slot. Reload and check all values again.
14. **Once-only timesheet schedule persists.** Use **Europe/London today + 5 days**, time `14:45`, recipient `payroll.<run>@example.test`. Turn timesheets on, choose **Once, on a date**, fill date/time/recipient and save. Expect enabled once row, weekday null, Europe/London, that one recipient, last_run_at null. `run_at` is 14:45 UK (13:45Z in BST, 14:45Z in GMT). Reload: all fields persist and invoice reminders remain weekly. This is a future schedule; nothing should send.
15. **Cron authentication and no premature sends.** With the schedules from 13–14, GET `/api/cron/daily` using no header, wrong Bearer and the right secret without Bearer: each must be 401. With the exact test Bearer: expect 200, emailSchedules and xeroSweep result objects, no errors/skipped state, at least two schedules read, emails/drafted/failed/errors all zero. Mock mail count unchanged; both schedules remain enabled with last_run_at null and no run rows. It does not wait for tomorrow's hosted cron.
16. **Company and role isolation.** Preserve those two rows. Sign in through the anon client as global beta admin: selecting this solo company's schedules returns none; update/delete affect no rows; inserting/upserting into that company fails. Its original rows remain unchanged. Global alpha office can read alpha's own schedules but not this solo company's, and cannot upsert its own company's schedule. Use the existing `signedInClient` fixture, not the service key, for the refusal checks.

## What can and cannot be proved in CI

All **16 browser cases** and **six database checks** are designed to run in the existing isolated CI job; none intrinsically requires a live provider or a person. A skipped case, failed startup, wrong backend identity, missing atomic-save fixture, failed release verification, non-empty outbound-block log or leaked synthetic rows is a failed/incomplete run, not a pass.

This worker currently cannot extract the backend image within its disk limit; CI needs enough disk for the Supabase images, database and app build. Registry authentication, a healthy Docker daemon, free ports 54320–54329/3001/3002/3999 and Chromium installation are prerequisites. Keep the existing CI port reservation and GHCR login steps. If GitHub rejects branch publication, do not claim CI ran the unpushed commit.

CI cannot establish that real Microsoft consent, refreshed real credentials, a real sender's DNS/domain verification, actual mailbox delivery, or the hosted scheduler works in production. Those require separately authorised live verification and are outside this mock-only job. No customer message, live provider call, production SQL, merge or deployment is authorised here.
