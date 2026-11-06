# Known limitations and recovery decision guide

**DRAFT - controlled document, not approved.**

Prepared for: Rhys
Status: draft written 2026-11-06 from the sources listed in each item. Nothing in this document has been run, applied, merged or deployed.
Scope: plain-English facts about what the test evidence does and does not prove, and what to do on cutover day if something goes wrong.

How to read this document:

- Every fact has a source file. A fact with no source, or a source that could not be checked, is marked **NOT VERIFIED**.
- Where two sources disagree, both are shown and the item says so.
- Part 2 only uses existing release rollbacks, existing feature switches, and the freeze rules. It does not invent new steps.
- Nothing here authorises production SQL, a merge, a deploy or a switch change. Those need Rhys.

---

## Part 1: Known limitations

### Summary table

| # | Limitation | What it means for John | Severity | Status |
|---|---|---|---|---|
| L1 | Safeupdate guard could not be loaded in 753 stand-in test sessions | Enforcement is proven only through one API-path test, not in those sessions | Medium | Sourced |
| L2 | Local database tests do not prove hosted Auth, MFA or RLS | The real hosted sign-in and permission path has not been tested by these runs | High | Sourced |
| L3 | Browser suite failed on the latest candidate run that was read | The browser gate is not green on the evidence read | High | Sourced |
| L4 | Integration browser test "Microsoft Connect" test 5 still uses the old flow | One browser spec may fail for a reason unrelated to the code under review | High | Sourced |
| L5 | npm audit lists 32 advisories (report only) | Production-package gate found 0; the rest are not gated | Medium | Sourced |
| L6 | Tests with fixed dates go stale | Future test failures in CI; no direct effect on John's data | Low | Sourced, with a disagreement noted |
| L7 | Xero cancel of a connect link may not revoke a token Xero already issued | Unknown whether a cancelled link fully cuts off Xero access | High (if true) | NOT VERIFIED |
| L8 | AI, Xero transfers and job profit are off by default | Nothing sends or switches on without an admin turning it on | Info | Sourced; the "recent code" rule is partly NOT VERIFIED |
| L9 | Release 151 header says "PROPOSAL, not registered" | Unclear from the file alone whether 151 is in the release plan | Medium | Sourced, conflicting |
| L10 | Release tests ran on PostgreSQL 16; the preflight expects 17.x | Behaviour on the production database version is not proven | Medium | Sourced |

---

### L1. Safeupdate guard could not be loaded in stand-in test sessions

- **What it is:** Some database test sessions cannot load the `pg-safeupdate` extension. In those sessions the test that checks a bare `UPDATE` or `DELETE` is refused was not run.
- **What it means for John:** Nothing is wrong with his data as far as these runs show, but the protection against a careless bulk change is only proven through the real API path, not in every session.
- **Severity:** Medium.
- **Workaround:** Rely on `tests/db/safeupdate-api-path.test.ts` for enforcement. Ask for this to be stated in the cutover sign-off. Do not describe the guard as proven in every session.
- **Evidence:**
  - Count of 753 sessions: `/tmp/claude-0/s/run-watch-42196310774.md` line 42 ("SAFEUPDATE-NOT-LOADABLE affected stand-in sessions: 753"), read from the CI log.
  - The CI step that prints the count and states the limitation: `.github/workflows/ci.yml` lines 264-271 (in the worktree at `/tmp/claude-0/s/w-doc-limits`).
  - Commit `f6469cc` subject ("safeupdate API-path proof, per-session evidence of sessions without the guard"): `/tmp/claude-0/s/evidence-pack-v2.md` section 1.
  - Run `42203506413` shows the same step as successful; its count was **NOT READ** in that watch file (`/tmp/claude-0/s/run-watch-42203506413.md` line 54).

### L2. Local database tests do not prove hosted Auth, MFA or RLS

- **What it is:** The database tests run against a disposable local Postgres with a stand-in shim for the Supabase API layer. The hosted Supabase stack (real PostgREST, real Auth sessions, real MFA) was not used.
- **What it means for John:** The sign-in, two-step sign-in and row-level access rules have been checked locally, not on the hosted system he uses.
- **Severity:** High.
- **Workaround:** A hosted check of sign-in, two-step sign-in and company isolation before cutover, done by someone with hosted access. Not done in these runs.
- **Evidence:**
  - "Real PostgREST/Supabase behaviour (stand-in shim only)" listed under "NOT tested / not proven": `/tmp/claude-0/s/overnight-151.md` lines 82-86.
  - The same section also lists: real Xero OAuth, real e-mail delivery of the code, the CI workflow itself (edited, never run at that point), and Next build against the backend.

### L3. Browser suite failed on the latest candidate run that was read

- **What it is:** On candidate run `42172753204` (commit `8e49fcb`), the browser suite ran 609 tests: 605 passed, 1 failed, 3 did not run. The CI gate reported "FAIL: integration failure".
- **What it means for John:** The candidate has not passed the full browser gate on the evidence read here. Later runs were still in progress or not read at the time of the source files.
- **Severity:** High (cutover gate).
- **Workaround:** None in this document. The candidate must not be treated as ready until a run is green on the exact SHA and Rhys decides.
- **Evidence:**
  - `/tmp/claude-0/s/evidence-pack-v2.md` section 2 (run 1117 row and "Run 1117 detail").
  - Latest watched run `42203506413` on SHA `9b63382e`: browser suite still in progress at 11:33:53Z with no failure reported by the API; "Possible hang, not confirmed" (`/tmp/claude-0/s/run-watch-42203506413.md` last entry). Its result is **NOT VERIFIED** at the time of writing.
- **Note:** Diagnostic run `42189581795` (PR #442 branch, head `6bd6baab`) passed 8 of 8 in the same spec. That is a different branch and does not clear the candidate (`/tmp/claude-0/s/evidence-pack-v2.md` section 3).

### L4. Microsoft Connect browser test (test 5) fails on a 90-second timeout

- **What it is:** `tests/e2e/integrations-connect.spec.ts` test 5 ("the company admin's Microsoft Connect ...") fails with "Test timeout of 90000ms exceeded" at `page.waitForRequest`. Tests 6, 7 and 8 of the same file did not run.
- **What it means for John:** The root cause of the timeout is **NOT READ**. It may be a real bug, a slow environment, or an outdated test. Nothing read here decides which.
- **Severity:** High (it is the browser failure in L3).
- **Workaround:** Find the root cause from the job log before any push. Do not retry blindly.
- **Evidence:**
  - Failure text: `/tmp/claude-0/s/evidence-pack-v2.md` section 2 (run 1117 detail).
  - Spec "still drives the OLD flow (43-char token URL ..., token_hash column, no e-mailed code)... needs a rewrite": `/tmp/claude-0/s/overnight-151.md` line 74. This is a second reason the spec may be stale. Whether it is the cause of the timeout is **NOT VERIFIED**.

### L5. npm audit lists 32 advisories (report only)

- **What it is:** The full dependency audit reports 32 advisories: 2 low, 14 moderate, 13 high, 3 critical. The step is marked report-only (`|| true`).
- **What it means for John:** The production-packages gate (high or critical, production dependencies only) found 0 and passes. The other advisories are not blocking and have not been assessed here for whether they can be reached in production.
- **Severity:** Medium.
- **Workaround:** Keep the production gate. Do not describe the 32 as either harmless or exploitable. Assessment: **NOT VERIFIED**.
- **Evidence:**
  - `/tmp/claude-0/s/run-watch-42203506413.md` ("web job log read"): "found 0 vulnerabilities (gate passed)" and "32 vulnerabilities, 2 low, 14 moderate, 13 high, 3 critical" from the npm ci summary, on head `9b63382e`.
  - `.github/workflows/ci.yml` lines 125-128 (production gate `--audit-level=high`, all-packages step report only).

### L6. Tests with fixed dates go stale

- **What it is:** Some database and browser tests use fixed calendar dates. When the clock passes them, the tests fail (or can fail) even though the product code is unchanged.
- **What it means for John:** No direct effect on his data. It can cause red CI runs that look like product failures.
- **Severity:** Low.
- **Evidence and detail:**
  - At base `e70f6633` the fixed dates are still in 2026. Confirmed in the worktree: `tests/db/internal-jobs.test.ts` and `tests/db/booking-writes.test.ts` and `tests/db/sales-order-machines.test.ts` contain 2026 dates and no 2027 dates.
  - A +392-day shift (for example 2026-11-09 to 2027-12-06) is written up in `/tmp/claude-0/s/dates-shifted.md`. It is a proposed or later change, not in `e70f6633`.
  - The shifted dates still go stale later. `/tmp/claude-0/s/stale-dates-sonnet.md` (lines 29-47, audited at head `9b63382e`): booking-writes around Mon 2027-12-13, sales-order-machines around Tue 2027-12-28, internal-jobs around Fri 2027-12-03, and the July 2027 daylight-saving case on Fri 2027-07-02 07:00Z.
  - The audit's own recommendation: compute the start date from the database clock rather than shifting again (`/tmp/claude-0/s/stale-dates-sonnet.md` line 47).
  - **Disagreement on watch items:** the brief names `tests/db/quote-lifecycle.test.ts` (`valid_until` 2026-12-31) and three job-board specs (`due_date` 2026-12-01) as later watch items. `/tmp/claude-0/s/stale-dates-sonnet.md` says the quote-lifecycle value is stored and never read by the test ("none needed", line 116), and rates the three job-board specs "unsure (low)", layout-only, with a "Late" label possible after 1 Dec 2026 (lines 43-45, 133-147). Both are kept as watch items here, not as failures.
- **Note on the first failure:** A CI run on `42196310774` failed on `tests/db/internal-jobs.test.ts` with a 42501 error (`/tmp/claude-0/s/run-watch-42196310774.md` line 34). That run's cause is **NOT READ** beyond the assertion text, and it is not confirmed to be a date issue.

### L7. Xero cancel of a connect link may not revoke a token Xero already issued

- **Status: NOT VERIFIED.**
- **What it would mean for John:** If a link is cancelled after Xero has already issued a token, the company's Xero access might still work until that token expires or is revoked. That would be a real exposure.
- **What was checked:** Release 151 cancels invites and stops them being used (`supabase/release/151_xero_invite_hardening.release.sql` lines 380-414, "Cancel one open invite"; the cancel sets `revoked_at` and clears `code_hash`). No file read here says whether a Xero token is revoked on cancel. The cancel test name refers to "cancelling ... while the Xero callback is completing" (`tests/db/xero-invite-cancel-during-callback-151.test.ts`), which is about the link, not the token.
- **Related draft (not merged):** PR #438 (`codex/pending-oauth-revoke`) is titled as a pending-oauth revoke change. Its content was not read. Source: `/tmp/claude-0/s/evidence-pack-v2.md` section 4.
- **Action needed:** Rhys or a reviewer reads the Xero token path and the revoke call before any statement is made to customers.

### L8. AI, Xero transfers and job profit are off by default

- **What it is:** Three features are switched off when a company is set up:
  - Tolra AI round-up and RFQ-to-quote helpers: `roundup_enabled` and `rfq_enabled` default to FALSE (`supabase/release/101_ai_helper.release.sql` line 14, lines 59-60).
  - Xero transfers: `xero_transfer_hold.enabled` defaults to false, and release 149 inserts a row for every existing company with `enabled = false`, reason "installed off" (`supabase/release/149_xero_launch_hold.release.sql` lines 31, 44).
  - Job profitability actuals: `job_costing_settings.enabled` defaults to false (`supabase/release/148_job_profitability_actuals.release.sql` line 30).
- **Turning on:**
  - Xero transfers: the release requires the company's second sign-in step to be on, and a fresh authenticator code from the last 15 minutes (`149_xero_launch_hold.release.sql` lines 130, 161).
  - Profit: the enable path calls `assert_privileged_aal()` (148 line 125). **NOT VERIFIED:** whether a fresh-code (15-minute) rule applies to profit.
  - AI: **NOT VERIFIED** whether turning AI on needs a fresh code. The function body was not read in full.
- **AI spend cap:** Release 150 sets the default own-key monthly cap to 1000 pence on rows made from then on, and forces AI off when an API key is changed or removed (`150_ai_cap_key_off.release.sql` lines 26-27 and header). Enforcement of the cap in live use is **NOT VERIFIED** beyond the stand-in tests.
- **What it means for John:** Nothing sends to Xero, and no AI or profit view appears for a company, until an admin turns it on. His company's switch state should be checked on cutover day, not assumed.

### L9. Release 151 header says "PROPOSAL, not registered"

- **What it is:** The header of `supabase/release/151_xero_invite_hardening.release.sql` line 1 says: "PROPOSAL, not registered in supabase/release-plan.json or CI."
- **Conflict:** The CI integration job log shows "Install one-time releases 145,146,147,148,149,150,151" as a step (`/tmp/claude-0/s/run-watch-42203506413.md` at 10:49:39Z). So the CI does install 151 on that head.
- **Status:** Whether `release-plan.json` lists 151 was **NOT VERIFIED** (not read).
- **Action needed:** Before cutover, confirm 151 is registered in the release plan, and remove or correct the header.

### L10. Release tests ran on PostgreSQL 16 only

- **What it is:** The release checks were run on PostgreSQL 16.15 in local stand-in clusters. The 151 release preflight header expects 17.x.
- **What it means for John:** Behaviour on the production database version is not proven by these runs.
- **Severity:** Medium.
- **Workaround:** Confirm the production database version and whether a PostgreSQL 17 rehearsal is needed. Not decided here.
- **Evidence:** `/tmp/claude-0/s/overnight-151.md` line 86 ("Release on Postgres 17 ... (PG16 only; preflight header expects 17.x)").

---

## Part 2: Recovery decision guide

### Ground rules (apply to every row)

1. **No production SQL, merge or deploy without Rhys.** Each row below ends with Rhys deciding.
2. **Production SQL only through the numbered release route** (`supabase/release/NNN_*.release.sql`, its verify file, and its rollback). No ad-hoc SQL.
3. **Never partially re-paste production SQL.** If a release stops part-way, it has been run as one transaction and is either kept or not kept. Do not run pieces by hand.
4. **Hotfix path (the only route for an unplanned code change):** a separate branch, a failing regression test written first, CI on the exact SHA, an independent reviewer, and Rhys's approval. No push on a guess.
5. **Never push to CI on a guess.** Find the full cause from the logs first.
6. **Stop and ask Rhys** for any trigger in the escalation list below.

### Decision table

Columns: what happens on cutover day, what to do, who decides, what NOT to do. Guard facts come from the first 30 lines of each rollback file.

| If this happens on cutover day | Do this | Who decides | Do NOT do this |
|---|---|---|---|
| A release SQL file fails part-way | Stop. Do not continue to the next numbered release. Record the error text and the release number. Each release runs as one transaction, so a failed release keeps none of its own changes (`101_ai_helper.release.sql` and `065_admin_mfa_onboarding.release.sql` headers: "applied as ONE transaction"). | Rhys | Do not re-paste or hand-run any part of the file. Do not start the next release. |
| A verify file shows any row not true after install | Stop. Leave the install as it is. Record which row failed. | Rhys | Do not roll back on your own. Do not mark the verify as passed. |
| Need to undo release 151 (Xero connect link hardening) | Use `supabase/release/151_xero_invite_hardening.rollback.sql`. It refuses while any 151 invite is open. Cancel open invites first through the app (admin, second sign-in step). | Rhys | Do not set `tolra.x151_accept_deleting_open_invites = 'yes'` unless Rhys has said so: that rollback deletes open invites made under 151. Note that 151's rollback restores the 107 token-link functions. |
| Need to undo release 149 (Xero transfer hold) | Use `supabase/release/149_xero_launch_hold.rollback.sql`, only with Rhys's separate approval. It refuses while a connected Xero company is held off, or a queued Xero document is held for review. It must not run while any Xero sender, app or cron is active. Roll the app back to the code without the hold as well. | Rhys (separate approval, the rollback header says "there is no automatic rollback") | Do not set `tolra.x149_accept_old_sending = 'yes'` without Rhys. Do not roll back the database while any sender is running. Do not leave the app on code that has the hold but not the function, or on the reverse. |
| Xero transfers have been switched on and something looks wrong | Turn the transfer switch off in the app as the company admin. Check how it reads afterwards. The exact off rules (including whether a fresh authenticator code is needed) are **NOT VERIFIED**; check the function before relying on it. | Rhys (the company admin turns it off; Rhys decides whether to keep it off) | Do not turn it on again to "test". Do not roll back 149 to switch it off; use the switch. |
| AI helper is causing cost or unexpected behaviour | Turn AI off for the company in the app. Release 150 already forces AI off when an API key changes. | Rhys | Do not enable AI for any company to test it. |
| Need to undo release 146 (Tolra-provided AI) | The rollback at `supabase/release/146_tolra_provided_ai.rollback.sql` says "REVIEW ONLY; NOT APPLIED" in its header. It refuses while any Tolra AI request is still `reserved`; settle them first. It turns AI features off for companies that had selected Tolra. | Rhys | Do not run it as a routine step. Do not run it while any request is reserved. |
| Need to undo release 150 (AI cap and key change) | Use `supabase/release/150_ai_cap_key_off.rollback.sql`. It refuses unless 150 is installed. It puts the cap default back to 500 and restores the earlier key functions. It switches nothing on, and switches already turned off stay off. | Rhys | Do not expect AI to switch back on after rollback. Do not treat the rollback as a fix for a cost problem. |
| Need to undo release 148 (job profit) | Export `job_cost_snapshots` first. The rollback drops the switch, machine links, declarations and the job cost records. Jobs closed in between have no record afterwards. Deploy or leave the UI in a state that does not read the removed tables. | Rhys (the header says "Rhys's approval first") | Do not run the rollback without a full export. Do not drop cost records to fix a display problem. |
| Need to undo release 147 (job delivery notes) | Use `supabase/release/147_job_delivery_note.rollback.sql` only after Rhys decides the numbering rule. Its header says a rollback before the counter step needs Rhys's decision on numbering first. Delivery notes are kept; only request keys and the hold table go. | Rhys | Do not roll back before the numbering decision. Do not delete delivery notes. |
| Need to undo release 145 (company setup ticks) | Use `supabase/release/145_company_setup.rollback.sql`. It drops only the setup progress table. Company details, users and records are kept. | Rhys | Do not treat it as a data fix. |
| Admin cannot sign in or cannot pass the second sign-in step | Stop. Do not change the company's two-step (MFA) setting or any RLS, auth or MFA rule. Follow the escalation rule. | Rhys | Do not switch the company's second sign-in requirement off to get in. Do not weaken auth, MFA or RLS. (CLAUDE.md: the MFA switch is a stop-and-ask item.) |
| The company's "require admin MFA" setting cannot be turned on | This is expected while any active admin has no verified factor (release 065 guard). Fix the admin's factor first. | Rhys | Do not bypass the guard with SQL. |
| Browser or CI gate fails on the cutover candidate | Stop. Do not merge, do not deploy, do not re-run to "see if it passes". Find the full cause from the logs (L3, L4). | Rhys, then the independent reviewer | Do not push a fix without the hotfix path. Do not retry blindly. |
| A fix seems urgent on cutover day | Use the hotfix path only: separate branch, failing regression test first, CI on the exact SHA, independent reviewer, Rhys approval. | Rhys | Do not push straight to the candidate branch. Do not skip the reviewer. |
| A fixed-date test fails on cutover day | Note it. Check whether the failure is a stale date (L6). Do not change dates on cutover day. | Rhys | Do not change the test to pass. Do not hide it with a skip. |
| Data looks wrong for a company after a release | Stop. Do not run any corrective SQL. Record the company, the table and the symptom. | Rhys | Do not run ad-hoc SQL against production. Do not re-run a release to "fix" data. |
| An unknown Xero connection or token issue appears | Stop. Disable the Xero transfer switch if it is on (see the Xero row). Record it. | Rhys | Do not revoke or re-issue tokens by hand. Do not run SQL against the connections table. |

### Escalation: stop and ask Rhys

Stop the work and ask Rhys before doing anything else if any of these happen:

1. Any production SQL, including any step of a numbered release.
2. Any change to the company's two-step (MFA) setting, or any change to auth, MFA or RLS.
3. Any cutover, deploy, merge to main, or change to the `ready` label on a PR.
4. Any secret, token or key is needed, shown or changed.
5. Any test or verify file fails in a way that is not clearly a stale date.
6. A rollback refusal message appears. Do not set the override variable without Rhys.
7. A Xero token, connection or send looks wrong.
8. An AI cost figure or cap looks wrong.
9. Data for a company looks wrong, missing or duplicated.
10. A release says "already applied" or "not applied" when the marker shows otherwise.
11. Any step is taking far longer than its normal time, or a CI job looks stuck (the browser step in L3 was still running after 45 minutes when last watched).

---

## Items NOT VERIFIED (collected)

- L7: whether cancelling a Xero connect link revokes a token Xero already issued.
- L3 (latest status): the final result of candidate CI run `42203506413` on `9b63382e` (browser suite still running when last read).
- L4: the root cause of the test 5 timeout.
- L5: whether any of the 32 non-production advisories can be reached in production.
- L6: quote-lifecycle `valid_until` and the three job-board specs as failures (sources say unread or low risk).
- L8: whether profit (148) and AI turning on need a fresh authenticator code; the exact rules for turning the Xero transfer switch off; whether the AI cap is enforced in live use.
- L9: whether `supabase/release-plan.json` lists release 151.
- L10: behaviour on the production PostgreSQL version.
- Part 2: the exact off rules for the Xero transfer switch and the company MFA setting; whether a PostgreSQL 17 rehearsal is needed.
- Hosted Auth, MFA and RLS behaviour (L2): not tested by any source read here.
- Any claim about the production system's current state: none was read.
