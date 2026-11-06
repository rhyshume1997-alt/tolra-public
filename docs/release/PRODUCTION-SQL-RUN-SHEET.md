# Production SQL run sheet, Thu 12 Nov cutover (releases 138 to 151)

> **NOT APPROVED - prepared for review; no production SQL may be run without Rhys.**
>
> This is a DRAFT. It is not permission to run anything. No SQL was run, applied or tested to write it. Everything below was read from files in the repository at commit `e70f6633b0f02f0e1dd38391ade87330d38a6a1c`. Anything that could not be confirmed from a file is marked **NOT VERIFIED**.

## 0. How to read this sheet

- A "step" is one release file. Run each step as a whole file, once, in the order of section 3. Never paste part of a file. Never run a file a second time. Never edit a file.
- Every release file is one transaction (`BEGIN;` ... `COMMIT;`). If it stops with an error, nothing from that file is kept. A stop is not a failure to fix on the night: it is a STOP (section 2).
- "Preflight" means the read-only query `supabase/verify/release_preflight.sql`. It returns three columns, `check`, `value`, `expected`. For each release it has one row whose `check` is the marker name quoted in the step. The `value` reads `not applied` before and `applied` after.
- "Verify" means the read-only file listed for the step. Every row must be `t` (true). CI treats any row whose last column is not `t`, or no rows at all, as a failure (`.github/workflows/ci.yml:337-341`, `scripts/ci-schema-markers.sh`).
- Who approves: the repository only states Rhys's approval for the rollbacks of 138, 140, 141, 143, 148 and 149 (quoted in each step). For every forward release the instruction for this cutover is that Rhys approves. Anything else is **NOT VERIFIED**.

## 1. Pre-flight checklist (before any step)

| # | Check | Status |
|---|-------|--------|
| 1 | Rhys has written approval for this run sheet and for the exact commit SHA below. | owner action, not verifiable here |
| 2 | The exact approved SHA is: `______________________` (candidate commit the files come from). This sheet was prepared against `e70f6633b0f02f0e1dd38391ade87330d38a6a1c`. | owner action, not verifiable here |
| 3 | The operator has checked out that SHA and every file hash in section 4 matches (`sha256sum <file>`). Any mismatch: STOP, do not run that file. | owner action, not verifiable here |
| 4 | Backup / restore point of the production database taken and its restore tested or at least confirmed restorable. Time taken: ________ Reference: ________ | owner action, not verifiable here |
| 5 | The operator is connected to the PRODUCTION project that Rhys named for this cutover. Never the JNREng project. Project name read back: ________ | owner action, not verifiable here |
| 6 | The operator's database role is the one the preflight expects. Preflight row 2 expects `postgres; createrole true`, row 1 expects Postgres `17.x` ("any other major: stop and report") (`supabase/verify/release_preflight.sql:331-332`, rows `n = 1, 2`). | run preflight, read the rows |
| 7 | Preflight run once in full, read-only, before step 138. Every baseline marker the release depends on reads `applied` (the file's own wording: "before the release: 013 applied, 014 onwards as recorded in the sign-off"). Which baseline migrations are already on production is **NOT VERIFIED** from the repo: `supabase/applied-migrations.json` stops at 095 and is not a record of 096 to 137. | owner action |
| 8 | The three "needs" rows 56, 57, 58 (134, 136, 137 prerequisites) read as their `expected` text says. A `false` or `other` value is a STOP (the preflight text says "stop, ... refuses to apply"). | run preflight, read the rows |
| 9 | Nobody is using the app during the run, and no Xero sender, app job or cron is active (stated as a requirement only for the 149 rollback in `149_xero_launch_hold.rollback.sql:6`; applying it to the whole run is this sheet's caution). | owner action |
| 10 | The app code that matches the schema is deployed or held as Rhys decides. Order of code deploy against SQL is **NOT VERIFIED** (not in any file read for this sheet). | owner action |
| 11 | Evidence table (section 7) is open and a second person is watching. | owner action |

## 2. Universal STOP rules

STOP means: do nothing further, change nothing, do not retry, do not "fix" the file, do not run a later step, and tell Rhys with the exact error text or output.

1. A preflight marker row for the step reads `applied` before you run it. (That release has already been applied or is half-known. Never re-apply. The files are written to refuse a repeat, but this sheet's rule is not to try.)
2. A release file ends with any error. The transaction is rolled back; the correct state is "still not applied". Re-run the preflight to confirm the marker still reads `not applied`, record the error, then STOP.
3. After the file ran without error, the marker does not read `applied`.
4. Any verify row is not `t`, or the verify file returns no rows.
5. A file hash does not match section 4.
6. A guard message in the file text, for example "stop and compare it first" or "stop and check release preflight". These are the file's own stop instructions.
7. Anything unexpected the operator cannot explain.

Do not start any rollback without Rhys. A rollback is its own decision (section 5).

## 3. Numbers, order and dependencies

Numbers that **exist** in this candidate (`supabase/release-plan.json`):

| Group | Numbers | Source |
|-------|---------|--------|
| JNR cutover numbered releases, in this order | 138, 140, 141, 143, 144 | `release-plan.json` `jnr_cutover_numbered_order`; `numbered_through` is 144 |
| One-time post-144 releases, in this order | 145, 146, 147, 148, 149, 150, 151 | `release-plan.json` `phases`; each has `after` = the previous number |

Numbers that **do not exist** as releases here:

| Number | What the files say |
|--------|--------------------|
| 139 | No migration, release or plan entry. `140_import_source_ref.release.sql:22-23` says "138 and 139 are held for chasing". Nothing for 139 exists in the tree. |
| 142 | `release-plan.json` `numbers_not_in_this_candidate`: "email_schedule_weekdays: optional, off by default, not in the JNR cutover". No 142 file exists in `supabase/migrations`, `release` or `verify`. |

**Order to run: 138, 140, 141, 143, 144, 145, 146, 147, 148, 149, 150, 151.** The plan checker (`scripts/check-release-plan.mjs`) enforces ascending order and that each post-144 phase's `after` is the previous number. It printed OK on this commit (read-only run).

What each step needs in place, quoted from the file's own guard (the "dependency"). "Not enforced" means the file does not test it, so only this sheet's order protects it.

| Step | Needs (from the file) | Enforced by the file? |
|------|-----------------------|-----------------------|
| 138 | Baseline 000, 027, 033, 036, 106, 108 objects and 076's `invoice_issue_lock`: "138: 000 / 027 / 033 / 036 / 106 / 108 objects are missing; apply them first" (`138_chase_steps.release.sql:60`); `email_templates_key` must be 106's (`:65`); `invoice_issue_lock` must be 076's or 138's (`:81`). | Yes |
| 140 | Tables `invoices, quotes, purchase_orders, jobs, sales_orders`: "140: invoices, quotes, purchase_orders, jobs or sales_orders (000) is missing" (`:36`). | Yes. Does not require 138. |
| 141 | "141 needs 000 (organizations, jobs), 013, 015, 033 and 036" (`141_opening_wip.release.sql:37`). | Yes. Does not require 138 or 140. |
| 143 | "143: a function or table it needs (000, 031, 033, 036, the audit log) is missing" (`143_costing_rates.release.sql:56`). Header says it is applied after 141 and before 144. | Yes for objects; order after 141 not enforced. |
| 144 | Header: "Prerequisite: 107." (`144_accounting_connections.release.sql:7`). There is **no guard block** in the file. Without 107 the file's `ALTER TABLE public.integration_connections ...` fails and the transaction rolls back (**NOT VERIFIED**, inferred, not run). | No explicit guard |
| 145 | "145: required release 144 is missing; stop and check release preflight" - tests `public.accounting_cloud_connections_ready()` (`145_company_setup.release.sql:4-8`). | Yes |
| 146 | "146: required release 145 is missing" - tests `company_setup_progress` and 144's function (`:4-8`); and the 133/134 reserve functions must have exact md5 bodies: "Review the existing reserve functions before applying N2; expected 133 and 134." (`:9-15`). | Yes |
| 147 | "147: required releases 145 and 146 are missing" - tests `ai_helper_tolra_control` and `company_setup_progress` (`:4-8`); plus baseline delivery-note functions and 5 enabled triggers (`:8-14`). | Yes |
| 148 | "148: required releases 145, 146 and 147 are missing" (tests `create_job_delivery_note` and `company_setup_progress`, `:7-9`); "148: release 143 (costing rates and its one save function) is not in place; 148 reads only 143's rates" (`:10-13`); refuses if a job costing table already exists (`:22-25`). | Yes |
| 149 | "149: required releases 145, 146 and 147 are missing" (`149_xero_launch_hold.release.sql:9`); needs the Xero tables and helpers "(084, 144, 033, 036, 035)" (`:16`); 084's `integration_claim_next` and `integration_retry_send` must still be 084's bodies (`:19-22`); "149: the hold table already exists; this one-time release was applied before" (`:24`). It does **not** test 148 (see inconsistency 3). | 145, 146, 147, 084, 144 yes; 148 not enforced |
| 150 | "150: required releases 145 and 146 are missing" (`150_ai_cap_key_off.release.sql:7`); the AI key functions, status and cap default must be exactly as 101, 122 and 146 left them, or "150 is already applied" (`:9-19`). It does **not** test 149 (see inconsistency 4). | 145, 146 yes; 149 not enforced |
| 151 | "151: the invite hardening already exists; this one-time release was applied before" (`151_xero_invite_hardening.release.sql:8`); "151: release 107 (the token connect link) is not in place" (`:13`); "151: release 149 (the Xero transfer switch) is missing; apply it first so a connection made through an invite starts with transfers OFF" (`:16`); helper functions (`:20`). It does **not** test 150 (see inconsistency 5). | 107 and 149 yes; 150 not enforced |

## 4. Step by step

Hash = SHA-256 at commit `e70f6633b0f02f0e1dd38391ade87330d38a6a1c`, computed with `sha256sum`. Paths are relative to the repository root. For every step the generic run is:

1. Preflight: marker row reads `not applied`.
2. Paste/run the whole release file once.
3. Preflight again: marker row reads `applied`.
4. Run the verify file: every row `t`.
5. Record in section 7.

Stop conditions for every step also include all of section 2.

### Step 138 - late-payer chasing (chase steps, pauses, drafts, payment claim)

- Purpose: per-company chase steps and chase drafts for approval (never an e-mail without approval), plus payment-claim functions; replaces 076's `invoice_issue_lock`; adds four columns to `invoices` (header, `138_chase_steps.release.sql:5-20`).
- Release: `supabase/release/138_chase_steps.release.sql`
  `beb4ee14c052829ab36d1d460e97747f16c4fd1eac92ec6f02b667e0b0f72d99`
- Verify: `supabase/verify/chase_steps_138.sql`
  `3ca0475b3b7d6673ce9ed29f2dc4613799cfe53e57c0b36c4d84f7349e88c95d`
- Rollback: `supabase/release/138_chase_steps.rollback.sql`
  `9bb52738a9395713c7700f7dcdfcb479c931bb4f68acfde58efbcf8cf75100af`
- Preflight marker: `marker 138 chase steps` - `not applied` before, `applied` after.
- Expected verify result: header says "every row should be TRUE (12)" (`chase_steps_138.sql:1`).
- STOP in addition: any of the file's own refusals, for example "138: email_templates_key is not 106's ... stop and compare it first", "138: public.invoice_issue_lock is not 076's ...", "138: a payment-claim function is already there and is not this file's" (`release.sql:60-87`); or the end checks "138: ... not definer, pinned and granted" / "the chase tables are not row-secured" (`:579-607`).
- Rollback refusals (`rollback.sql`): refuses if `chase_create_draft` or `chase_record_sent` is not 138's, if `invoice_issue_lock` is neither 138's nor 076's, if a payment-claim function is not 138's (`:17-30`), and at the end if it is "not back to 106's state" (`:110`). It has no data-based refusal: it DELETES all chase steps, pauses, chase records and open payment claims, and any saved wording for the three new template keys (`rollback.sql:1-8`). Header: "ONLY with Rhys's approval."
- Approves: Rhys (forward: per this cutover; rollback: stated in the file).
- Must NOT: edit the file; re-run; paste part of it; run `supabase/proposals/builder2_chase_settings_atomic.sql` (separate decision, section 6).
- Note: the release file equals `scripts/release-sql.mjs` applied to `supabase/migrations/138_chase_steps.sql`, apart from the first comment line (read-only diff run for this sheet).

### Step 140 - SliQ reference on imported documents (`source_ref`)

- Purpose: adds nullable `source_ref` to invoices, quotes, purchase_orders, jobs, sales_orders, with a trigger so only the import (owner/service role) can set it (`140_import_source_ref.release.sql:5-19`). No existing row changes.
- Release: `supabase/release/140_import_source_ref.release.sql`
  `d424a2fbcdc97d42189b897a06265f0fb1b443958a1a9837570b3cbed01b4af1`
- Verify: `supabase/verify/import_source_ref_140.sql`
  `fbe2570ebfcde3cd3856652b61e0449179b840f2a631efd7cfd832881a78d439`
- Rollback: `supabase/release/140_import_source_ref.rollback.sql`
  `32a561cfc03667a5fb04c152c4209f25263d01a2d05487450d1134a6e20cac69`
- Preflight marker: `marker 140 import source ref`.
- Expected verify: "every row should be TRUE (6)" (`import_source_ref_140.sql` header).
- STOP in addition: "140: a source_ref column already exists with another type; stop and compare it first"; "140: public.source_ref_import_only() exists with another body"; any "140 self-check" message (`release.sql:36-120`).
- Rollback refusal: "140 rollback stopped: N imported document(s) carry their SliQ number in source_ref; export them first and get Rhys's approval to drop it" (`rollback.sql:20`). Header: "ONLY with Rhys's approval."
- Approves: Rhys.
- Must NOT: run a SliQ import before 140 and 141 are verified (the importer refuses without 141's table, per `141_opening_wip.release.sql:22`; behaviour of the importer itself is **NOT VERIFIED** here); edit; re-run.

### Step 141 - opening work in progress record

- Purpose: new table `public.opening_wip` holding SliQ's WIP as a record only, read by admin and office, written only by the importer (`141_opening_wip.release.sql:5-21`).
- Release: `supabase/release/141_opening_wip.release.sql`
  `ae9f353bd85a7eefd56ae3fc0c89b6fc8ca532cf5fbda0df550171aec9bc2549`
- Verify: `supabase/verify/opening_wip_141.sql`
  `7125c1714ffc3c909dc2542281c66d25d1d526f41e88194c2615c29ae7eff949`
- Rollback: `supabase/release/141_opening_wip.rollback.sql`
  `d7846d089404289066380118c8cbf0ef0cd9d2366a6dd44b181fae291a232406`
- Preflight marker: `marker 141 opening wip`.
- Expected verify: "every row should be TRUE (9)" (`opening_wip_141.sql` header).
- STOP in addition: "141 needs 000 (organizations, jobs), 013, 015, 033 and 036 ..." and "141 self-check failed: public.opening_wip is not as written" (`release.sql:37, 90`).
- Rollback refusals: only "141 rollback: public.opening_wip is still there" / "the jobs table is missing" (`rollback.sql:13-16`, end checks). No data-based refusal: it drops the table and EVERY opening WIP row (`rollback.sql:1-5`). Header: "ONLY with Rhys's approval."
- Approves: Rhys.
- Must NOT: edit; re-run; treat the table as revenue (the header says nothing reads it).

### Step 143 - costing rates

- Purpose: three tables (`costing_materials`, `costing_machines`, `costing_defaults`) and `save_costing_settings_atomic`; no built-in rate, costing stays OFF for a company until it enters its own rates (`143_costing_rates.release.sql:5-27`).
- Release: `supabase/release/143_costing_rates.release.sql`
  `d1dc0e93c507b0c12d7d40028af0aa16aeb4cde5b1b54e3935aa88659e642ad8`
- Verify: `supabase/verify/costing_rates_143.sql`
  `5c5ec46c3f3fabbe1a17b2bf7ef4ddbc8d1bc26c08950174acfa14013cba0838`
- Rollback: `supabase/release/143_costing_rates.rollback.sql`
  `f83492c843232bdb58caadfaaea5c244045eaa6fb755b29540f82b1761217fd4`
- Preflight marker: `marker 143 costing rates` (pins the md5 of `costing_rates_stamp` and `save_costing_settings_atomic`).
- Expected verify: "every row should be TRUE (14)" (`costing_rates_143.sql` header).
- STOP in addition: "143: public.save_costing_settings_atomic exists with another body; stop and compare it first"; "143: public.costing_rates_stamp exists with another body"; the end checks "the costing tables do not have their 12 policies and row-level security" / "... EXECUTE grants are wrong" (`release.sql:56-66, 318-329`).
- Rollback refusals: only "143 rollback: something of 143 is still there" at the end (`rollback.sql:21`). No data-based refusal: it DELETES every company's costing rates (`rollback.sql:1-8`). Header: "ONLY with Rhys's approval." Rolling 143 back also breaks 148, which reads 143's tables.
- Approves: Rhys.
- Must NOT: apply `supabase/proposals/builder2_costing_settings_atomic.sql` ("superseded ... never applied", `release-plan.json`).

### Step 144 - cloud accounting connections

- Purpose: allow providers `microsoft`, `sage`, `quickbooks` on the connection tables; new `accounting_cloud_enqueue` trigger function so read-only connections never queue an outbound send; `accounting_cloud_connections_ready()` (`144_accounting_connections.release.sql:4-60`). No provider subscription is purchased and new app credentials are environment-only (`:7`).
- Release: `supabase/release/144_accounting_connections.release.sql`
  `d11cb063e367038fc76374e172770c08499ebd6cd541b10490eee8096410711b`
- Verify: `supabase/verify/accounting_connections_144.sql`
  `2f18baf81290e0b5de22b983dfb7b5c15a8cd058e0ace43261298c581a8e7593`
- Rollback: `supabase/release/144_accounting_connections.rollback.sql`
  `d3cd6f0d101f66769cd90d079b282e9ae55d0877f20a919f6363e0c01e565d8c`
- Preflight marker: `marker 144 accounting connections`. The marker only tests that `public.accounting_cloud_connections_ready()` exists (`release_preflight.sql:215`).
- Expected verify: the file does not state a row count in its header. Every row `t`. Number of rows the operator should see: **NOT VERIFIED** (about 5 `SELECT` rows by a text search, not confirmed).
- STOP in addition: any error. The file has no guard block of its own (see section 3).
- Rollback refusal: "Disconnect cloud connections and review/clear their expired states before rollback; no data was removed." when any `sage`/`quickbooks` row exists in `integration_connections`, `integration_secrets` or `integration_oauth_states` (`rollback.sql:3-8`). Header: "Roll back application first. Refuse to discard any company's live connection or sign-in." Approver for the rollback is not stated in the file: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: edit; re-run. Releases 145 to 151 all rely on 144's helper, so 144 is not rolled back while any of them is installed (this is this sheet's caution, derived from the guards in section 3).

### Step 145 - company setup progress

- Purpose: table `public.company_setup_progress` (setup ticks per company) with 3 row-level policies; source `supabase/proposals/n5_company_setup.sql`.
- Release: `supabase/release/145_company_setup.release.sql`
  `58a0560736b9a443952ee222796de030a39c439ee5c2ce47877b88ef07d59d6e`
- Verify: `supabase/verify/company_setup_145.sql`
  `1694fb6d41ee6c85c086f3600922179247e8fc966e461fbf799ee2314adc1a83`
- Rollback: `supabase/release/145_company_setup.rollback.sql`
  `5381d106de1ab65d91a68ce3caac24fb0d615e56b805fe34e5c36ca824872ec5`
- Preflight marker: `post-144 marker 145 company_setup`.
- Expected verify: every row `t`; row count not stated in the file header (**NOT VERIFIED**).
- STOP in addition: "145: required release 144 is missing; stop and check release preflight"; a repeat refuses because the table already exists ("Existing objects cause refusal, never overwrite", release line 2).
- Rollback refusal: none. The rollback is `DROP TABLE public.company_setup_progress;` and removes the setup ticks only (`rollback.sql`). Because 146 to 150 guards test this table, it is not rolled back while they are installed (derived from the guards). Approver not stated: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: run `supabase/proposals/n5_company_setup.sql` directly (the release copy carries the guard); edit; re-run.

### Step 146 - Tolra-provided AI (N2)

- Purpose: Tolra-provided AI key mode with per-company control tables and caps; renames the old own-key AI functions and replaces the public reserve/status wrappers (`146_tolra_provided_ai.release.sql`; source `supabase/proposals/n2_tolra_provided_ai.sql`). Off by default: **NOT VERIFIED** beyond the column default `enabled BOOLEAN NOT NULL DEFAULT FALSE` seen in the file.
- Release: `supabase/release/146_tolra_provided_ai.release.sql`
  `316862ac765251c6f602042dbd41fce46ce6a52b7eb73b5012575a326b84b9cd`
- Verify: `supabase/verify/tolra_provided_ai_146.sql`
  `67a85b0fc64775a0fab1469588dd1aaa90d12cd65da8490b8f4e60662d564f3d`
- Rollback: `supabase/release/146_tolra_provided_ai.rollback.sql`
  `37464a6daba9a0a881526f2ff10ff984398a721ce1fa8d38b5b517a39e0b8b0b`
- Preflight marker: `post-144 marker 146 tolra_provided_ai` (pins ten function bodies, definer/search-path and grants).
- Expected verify: every row `t`; row count not stated (**NOT VERIFIED**).
- STOP in addition: "146: required release 145 is missing"; "Review the existing reserve functions before applying N2; expected 133 and 134." (the 133/134 bodies are not the exact ones).
- Rollback refusal: "Settle outstanding Tolra requests before rollback." while any `ai_helper_requests` row has `key_source = 'tolra'` and `status = 'reserved'` (`rollback.sql:5-9`). Its header also says "REVIEW ONLY; NOT APPLIED", and that companies that had chosen Tolra are turned off. After a rollback, re-applying 146 on the same database is refused (CI evidence step `ci.yml:394-410` records this as informational): treat 146 as one-time. Approver not stated: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: edit; re-run; switch Tolra AI on during the cutover run (not part of this sheet).

### Step 147 - no-order delivery note (C17)

- Purpose: `create_job_delivery_note`, request-key guard, numbering guard; **every company that exists at install is held** (inserted into `dln_numbering_pending`) until its delivery-note counter step is run (`147_job_delivery_note.release.sql:47-53`, rollback header). The counter step is not part of the release; its scripts are in `supabase/cutover/` (see "After 147" below).
- Release: `supabase/release/147_job_delivery_note.release.sql`
  `795040328c6be99952076a0b320c9a8d2f2be7211a2b6898e0cb0b8d64bea5b3`
- Verify: `supabase/verify/job_delivery_note_147.sql`
  `e8866233169863a61cd88cf42d6cb59114685da6942d85943106f9b05288877b`
- Rollback: `supabase/release/147_job_delivery_note.rollback.sql`
  `f600cae91c030b6c0f9c0ba93c2459c44f0a2c4058ef4d62fb176427e41254ee`
- Preflight marker: `post-144 marker 147 job_delivery_note`.
- Expected verify: every row `t`; row count not stated (**NOT VERIFIED**).
- STOP in addition: "147: required releases 145 and 146 are missing"; "147: the delivery note functions and triggers it builds on (037, 078, 081, 085, 015, 034, 013) are not all in place".
- Rollback refusal: none in the file. The rollback drops the function, guards, the hold table and the request columns; delivery notes are kept. Header: "a rollback before the counter step needs Rhys's decision on numbering first" (`rollback.sql:5-6`). Approver otherwise not stated: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: edit; re-run.
- After 147 (separate operations, NOT part of the release, not in `release-plan.json`; each is its own Rhys decision): `supabase/cutover/set_dln_next_number.sql` (once, on cutover day, JNR's pad continuation), `supabase/cutover/keep_dln_numbering.sql` (for a company that keeps its Tolra series), `supabase/cutover/verify_dln_next_number.sql` (read-only, 10 PASS rows), `supabase/cutover/undo_dln_next_number.sql` (only if no number has been taken). Until the counter step runs, a held company cannot make a delivery note. Their hashes are not recorded here; compute them if Rhys includes them: **NOT VERIFIED**. They refer to a "C16 runbook" that is not in the repository.

### Step 148 - actual job costing

- Purpose: optional actual job costing: per-company switch, machine links, per-job declarations, frozen cost snapshots; reads ONLY 143's rates (`148_job_profitability_actuals.release.sql:2-3`). Off until a company's admin enables it: **NOT VERIFIED** beyond the file name `set_job_costing_enabled`.
- Release: `supabase/release/148_job_profitability_actuals.release.sql`
  `9576723ba27510906217d90d766bf0e8af7091e29af90fdd8f015b1f1674c903`
- Verify: `supabase/verify/job_profitability_actuals_148.sql`
  `e306109442cb027d244267899b41709fe77f0c07f1683d87d0d7a127cc9ba412`
- Rollback: `supabase/release/148_job_profitability_actuals.rollback.sql`
  `e3ad55a4c05ffd82988c1ed3a894e59dbb5a14c76a6a5b4ba5eb88da448e31ea`
- Preflight marker: `post-144 marker 148 job_profitability_actuals`.
- Expected verify: "every row must be TRUE (12)" (`job_profitability_actuals_148.sql` header).
- STOP in addition: any of the guard messages quoted in section 3, including "148: a job costing table already exists (this release, or PR 378's own rate tables); stop and compare it first".
- Rollback refusal: none in the file. It drops the switch, links, declarations and the JOB COST RECORDS (`job_cost_snapshots`); "Export job_cost_snapshots first if the recorded costs are needed" and "Rhys's approval first" (`rollback.sql:1-5`).
- Approves: Rhys (rollback stated in the file).
- Must NOT: edit; re-run; apply while 143 is absent.

### Step 149 - Xero transfer switch (launch hold)

- Purpose: a per-company Xero transfer switch, OFF for every company at install and after any connection change; nothing sends until a company admin turns it on; the backlog stays held until the admin approves it (`proposals/x149_xero_launch_hold.sql:1-23`, release copy `149_xero_launch_hold.release.sql`). Replaces 084's `integration_claim_next` and `integration_retry_send`.
- Release: `supabase/release/149_xero_launch_hold.release.sql`
  `1883f511ab4fe34ef9f029b1e1d7accb34764499e5746cbb45cc1f59ad1d3226`
- Verify: `supabase/verify/xero_launch_hold_149.sql`
  `6b1e10da92821900eb356679d7f4ef5ecd40804955eee34fa4c28ff0fcf348f9`
- Rollback: `supabase/release/149_xero_launch_hold.rollback.sql`
  `272328b934563628f7cc3a98c1dd537fd637ac14f020ca25b25e86fd853214ba`
- Preflight marker: `post-144 marker 149 xero_launch_hold` (11 pinned function bodies).
- Expected verify: every row `t`; row count not stated (**NOT VERIFIED**).
- STOP in addition: "149: required releases 145, 146 and 147 are missing"; "149: the Xero connection tables and helper functions it builds on (084, 144, 033, 036, 035) are not all in place"; "149: integration_claim_next or integration_retry_send is not 084's; stop and compare it first"; "149: the hold table already exists; this one-time release was applied before".
- Rollback refusals: "149 rollback: the hold table is not there; nothing to roll back"; "149 rollback refused: a connected Xero company is still held (off) ..." and "... a queued Xero document is still held for review ..." unless the runner first sets `tolra.x149_accept_old_sending = 'yes'` in the same session (`rollback.sql:11-22`). Header: "Needs Rhys's separate approval; there is no automatic rollback", "Never run while any sender, app or cron is active", and the app code must be rolled back to the version without the hold as well.
- Approves: Rhys (rollback "separate approval" stated in the file).
- Must NOT: set the accept-old-sending variable unless Rhys has accepted old sending; turn any company's transfer switch ON as part of this run (not in scope of the files read; any enabling is Rhys's decision); edit; re-run.

### Step 150 - AI cap 1000p and key change forces AI off

- Purpose: own-key default monthly cap 1000 pence (was 500); a key save, replacement or removal switches AI off; platform key removal function (`150_ai_cap_key_off.release.sql`; rollback header `rollback.sql:1-6`).
- Release: `supabase/release/150_ai_cap_key_off.release.sql`
  `df1329904b3465e87f9699a73b567218b919350b1268e101daefd3f5f796ad29`
- Verify: `supabase/verify/ai_cap_key_off_150.sql`
  `3d57f270bb95ceec85d157e74ad81ce8c5ab59fc28935b373fce147403e122d6`
- Rollback: `supabase/release/150_ai_cap_key_off.rollback.sql`
  `99778d85dca6cbdea2668155340613c3d46bd85f9f1bbed8be59ad928c2b120a`
- Preflight marker: `post-144 marker 150 ai_cap_key_off`.
- Expected verify: every row `t`; row count not stated (**NOT VERIFIED**).
- STOP in addition: "150: required releases 145 and 146 are missing"; "150: the AI key functions, status or cap default are not exactly as 101, 122 and 146 left them (or 150 is already applied); stop and compare first".
- Rollback refusals: "150 rollback: release 150 is not installed; nothing to roll back"; at the end "150 rollback: the restored functions or default are not exactly 101, 122 and 146" (`rollback.sql:10, 149`). It keeps rows made under 150 and does not switch anything on. Header says "Review first". Approver not stated: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: edit; re-run; treat 150 as needed before 149 (order is 149 then 150).

### Step 151 - Xero accountant invite hardening

- Purpose: replaces 107's token connect link with an opaque reference bound to one company, the creating admin and one recipient e-mail, with an e-mailed code, lockout, single use, expiry and a refusal log. It cancels every open 107 token link (audited) and removes 107's `integration_invite_create(text,text)` and `integration_invite_redeem(text,text,text)` (`151_xero_invite_hardening.release.sql:26-39, 109, 582`).
- Release: `supabase/release/151_xero_invite_hardening.release.sql`
  `b8604f882a0d0fd65df767d2abd989ed3740bcf18c72975141f9334e9c4a0dae`
- Verify: `supabase/verify/xero_invite_hardening_151.sql`
  `cf06251d2199e43afa88103d365c9e4a0ffc24eef6364a90d362f8a73ef9d4a3`
- Rollback: `supabase/release/151_xero_invite_hardening.rollback.sql`
  `b5ff7ec894aa6f85bf08fab3c0b5af348dc9a61b8f362fc2835d2923642f6dca`
- Preflight marker: `post-144 marker 151 xero_invite_hardening`.
- The md5 pins for 151 live in `supabase/verify/release_preflight.sql`, in that marker (lines 310 to 328). They are one `IN (...)` list of **eleven** md5 values, one per function, tied to `count(*) = 11` (lines 314-319); the 151 release file and the 151 verify file contain no md5 pins at all. The brief for this sheet said "four md5 pins"; the file shows eleven (inconsistency 7). The marker also pins that `integration_invite_code_verify`, `integration_invite_store_connection` and `integration_xero_picker_claim` are not executable by `authenticated`.
- Expected verify: every row `t`; row count not stated in the header (**NOT VERIFIED**).
- STOP in addition: "151: the invite hardening already exists; this one-time release was applied before"; "151: release 107 (the token connect link) is not in place"; "151: release 149 (the Xero transfer switch) is missing"; "151: the helper functions it builds on are not all in place"; any "151 self-check" message (`release.sql:582-611`).
- Rollback refusals: "151 rollback: release 151 is not installed"; **"151 rollback: open connect invites exist; cancel them first, or SET tolra.x151_accept_deleting_open_invites = 'yes' to delete them"** while any 151 invite is open (has a `ref`, not used, not revoked, not expired) (`rollback.sql:5-13`). Invites made under 151 are DELETED by the rollback (their audit rows stay), and the refusal log table is dropped with its data. Approver not stated: **NOT VERIFIED**.
- Approves: Rhys.
- Must NOT: set the accept-deleting-open-invites variable without Rhys; run it before 149; edit; re-run. Note the release's own first comment line calls 151 a "PROPOSAL, not registered in supabase/release-plan.json or CI". That text is out of date (inconsistency 1): the plan and CI do list 151.

## 5. Rollback summary (nothing here is approved)

Rollbacks exist for every step. None is part of the run. Use only if Rhys decides, in reverse order, one transaction each, then re-run preflight (marker back to `not applied`).

| Step | Refuses when | Data lost if it runs |
|------|--------------|----------------------|
| 151 | not installed; or any 151 invite is open, unless `tolra.x151_accept_deleting_open_invites = 'yes'` | all 151 invites; invite refusal log |
| 150 | not installed; or restored functions not exactly 101/122/146 | nothing deleted; settings kept |
| 149 | hold table missing; or a connected company is held; or a queued doc is held, unless `tolra.x149_accept_old_sending = 'yes'` | hold tables; backlog held becomes claimable |
| 148 | no guard in the file | switch, links, declarations, job cost records |
| 147 | no guard in the file | request keys; hold table (numbering decision needed first) |
| 146 | outstanding Tolra `reserved` requests | Tolra mode; features of companies on Tolra turned off |
| 145 | no guard in the file | setup ticks |
| 144 | any sage/quickbooks connection, secret or OAuth state exists | nothing if it refuses |
| 143 | only an end check | every company's costing rates |
| 141 | only an end check | all opening WIP rows |
| 140 | any document has a `source_ref` | the `source_ref` columns |
| 138 | wrong function bodies | all chase data, open payment claims |

Restore from the backup (pre-flight 4) is the other recovery route; whether a restore is acceptable at that moment is Rhys's decision: **NOT VERIFIED** (no restore procedure for production is in the files read for this sheet; `scripts/restore-backup.sh` and `scripts/backup-restore-drill.sh` exist but were not read).

## 6. What is NOT in this candidate or release

- 139 and 142 (section 3).
- `supabase/proposals/builder2_chase_settings_atomic.sql`: "separate chase settings release decision; requires 138; browser fixture is not production packaging".
- `supabase/proposals/builder2_costing_settings_atomic.sql`: superseded by 143, never applied.
- `supabase/proposals/builder2_atomic_settings.rollback.sql`: rollback only, never a forward input.
- The proposal sources for 145 to 151 (`n5_company_setup.sql`, `n2_tolra_provided_ai.sql`, `c17_job_delivery_note.sql`, `p148_job_profitability_actuals.sql`, `x149_xero_launch_hold.sql`, `a150_ai_cap_key_off.sql`, `p151_xero_invite_hardening.sql`): never run directly; the release copy is the only file to run. `check-release-plan.mjs` tests that each release contains the proposal body.
- The `supabase/cutover/*.sql` delivery-note counter scripts: separate operations (step 147 note).
- Anything that exists only on other branches (other Codex/Grok branches, PR #415, `cand/12nov-int`, the docs owned by other agents such as `docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md`): not in this tree and **NOT VERIFIED** here. The run sheet covers only the files at the SHA named in pre-flight 2.
- Docs referenced by the SQL but absent from this tree: `docs/RELEASE-CHECKLIST.md` (`release_preflight.sql:3`), `docs/RELEASE.md`, `docs/MIGRATIONS.md`, `Tolra Progress.md`, the "C16 runbook". Their content is **NOT VERIFIED**.
- Production state. The repo cannot show which baseline migrations (096 to 137) are on production. `supabase/applied-migrations.json` records 80 migrations, last 095. The preflight is the only check.
- What CI proved: `.github/workflows/ci.yml` installs 145 to 151 (`:319-352`) on a disposable local database after the numbered migrations are replayed; it does NOT run the 138 to 144 release files on that database, it builds them from the numbered migrations (`scripts/test-backend.sh reset` rebuilds "from numbered migrations only", `ci.yml:314-316`). The 138 to 144 release text equals the wrapped migration (read-only diff, this sheet), and `tests/rehearsal/upgrade.test.ts` applies release text through `scripts/release-sql.mjs`; whether that rehearsal covers 138 to 144 specifically is **NOT VERIFIED**. No result of any CI run is claimed here. CI does not run on production and proves nothing about the production data.

## 7. Evidence to record during the run (blank, to be filled in; do not pre-fill)

Date/time zone: ________  Operator: ________  Second person: ________  Approved SHA: ________  Backup reference: ________

| Step | Preflight before: marker value | File hash matched (y/n) | Started (time) | Release output (paste exact) | Preflight after: marker value | Verify rows: count / all `t`? | Finished (time) | Stop? (y/n, exact text) | Rhys OK to continue (initials) |
|------|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| 138 | | | | | | | | | |
| 140 | | | | | | | | | |
| 141 | | | | | | | | | |
| 143 | | | | | | | | | |
| 144 | | | | | | | | | |
| 145 | | | | | | | | | |
| 146 | | | | | | | | | |
| 147 | | | | | | | | | |
| 148 | | | | | | | | | |
| 149 | | | | | | | | | |
| 150 | | | | | | | | | |
| 151 | | | | | | | | | |

Final full preflight after 151 (all of 138, 140, 141, 143, 144 markers and `post-144 marker 145` to `151` read `applied`; the preflight text says "all applied before go-live"): ________

Not covered by the files: who runs each query, and where (SQL editor or `psql`), is Rhys's choice. CI uses `psql -v ON_ERROR_STOP=1 -X -At -F '|'` (`ci.yml:327`); production method **NOT VERIFIED**.

## 8. Inconsistencies found between plan, SQL and CI (for review, nothing changed)

1. 151 labelled "PROPOSAL, not registered ..." although it is registered. `supabase/release/151_xero_invite_hardening.release.sql:1` ("not registered in supabase/release-plan.json or CI"); `supabase/verify/xero_invite_hardening_151.sql:1` ("PROPOSAL, not registered in the release plan"); `supabase/proposals/p151_xero_invite_hardening.sql:1`. But `supabase/release-plan.json` phase 151 exists, `ci.yml:328` installs it and `scripts/ci-schema-markers.sh` checks it.
2. 143's header omits 148 and 151 from its order list: `supabase/release/143_costing_rates.release.sql:6` ("order 138, 140, 141, 143, 144, 145, 146, 147, 149, 150"). The plan has 148 and 151 as well.
3. 149 order vs plan: `supabase/release/149_xero_launch_hold.release.sql:3` ("Apply only after 147") and `supabase/verify/release_preflight.sql:223` ("apply only after 147") against `release-plan.json` phase 149 `"after": "148"` and preflight line 637 ("148 job costing before 149"). The 149 guard (`:8-17`) never tests 148.
4. 150 does not test 149: the guard (`150_ai_cap_key_off.release.sql:4-21`) checks 145/146 only, while the plan has `"after": "149"` and `release_preflight.sql:224` says "apply only after 149".
5. 151 order vs plan: `151_xero_invite_hardening.release.sql:2` ("Apply only after 107 and 149") against `release-plan.json` `"after": "150"` and `release_preflight.sql:225` ("apply only after 150"); the guard tests 107 and 149 only.
6. 144 says "Prerequisite: 107" (`144_accounting_connections.release.sql:7`) but has no guard block; 145 to 151 each have one.
7. "Four md5 pins" for 151 (the brief) against the file: one marker with eleven md5 values, `release_preflight.sql:314-319` (11 hex values counted in lines 310-328).
8. Stale comments in CI: `ci.yml:258-260` ("prepare/verify 145 and 146 ... Post-144 release plan: 145 N5 then 146 N2/cap") while the step at `:319-352` installs 145 to 151.
9. Stale repo documents: `tests/GO-LIVE-CANDIDATE.md` (3 Nov) states "This exact candidate does not include 139 or 140-143" and that N5/N2 have no release allocation; `tests/POST-144-RELEASE.md` covers 145 and 146 only. The plan now includes 140, 141 and 143 and 145 to 151.
10. Releases 138, 140, 141, 143 say "Safe to run again" in their headers (`140_import_source_ref.release.sql:21`, `143_costing_rates.release.sql:9`, similar in 138 and 141), whereas 145 to 151 are "one-time" and refuse a repeat. This sheet's rule is never to re-run any of them. (The 138 guard explicitly allows a second run if the bodies match, `138_chase_steps.release.sql:68-77`.)
11. `scripts/check-release-plan.mjs` checks for the numbered cutover entries only that the files exist and the marker is present (`:34-41`); it does not check that each cutover release equals its migration. This sheet found that they do (read-only diff), but the checker would not catch a change. It is also not invoked from `package.json`; it is called from `scripts/check-migrations.mjs:20` and `tests/unit/release-plan-preflight.test.ts`.
12. Rollback approvers are named in 138, 140, 141, 143, 148 and 149 only; 144, 145, 146, 147 (except the numbering note), 150 and 151 do not name one.
13. Three rollbacks (145, 147, 148) have no refusal condition at all and each destroys data of its feature: 145 drops the setup-ticks table; 147 drops the hold table (and so releases every company's DLN hold); 148 drops job cost records.

## 9. Files this sheet's claims rest on (hashes at `e70f6633b0f02f0e1dd38391ade87330d38a6a1c`)

| File | SHA-256 |
|------|---------|
| `supabase/release-plan.json` | `a2147d68bb678cfd38bf45e42a5ab6c75bb5150a427091372308e116ab87f9e5` |
| `supabase/verify/release_preflight.sql` | `c5c80ef5e0d5e7cb25d46cde48a888540dda98222641a133a159b19201a39b8d` |
| `scripts/check-release-plan.mjs` | `1a026166c8acc761e634d2e9dbb57e5965042a06e10a3578c945c8e1a679a0ad` |
| `scripts/ci-schema-markers.sh` | `d0b31ed65936e38ee0e0ea0f1f1bf9b6199ebd51335867384d0c5b8a2a0ae427` |
| `.github/workflows/ci.yml` | `97eb993dbe1916ce2ec74e7600a904638271f39f6db0092da4d17fb9df5aeb74` |
| `supabase/proposals/n5_company_setup.sql` (145 source) | `4938bdb504152594734bebc5d40cb55147e8bbae844fe3a45e7aaf30ae53ead8` |
| `supabase/proposals/n2_tolra_provided_ai.sql` (146 source) | `452da289f5fbbf1dac05f678552585f93d951d34b92ca6791cb2c568ddf57895` |
| `supabase/proposals/c17_job_delivery_note.sql` (147 source) | `2d3b6fdb1b60cc778cc7c4b2661e296fe2751c6963d37980d7c78a856c43b460` |
| `supabase/proposals/p148_job_profitability_actuals.sql` (148 source) | `a5807158bf8e48c7e5f0b30d1e1c932662e3a0acb0b3527fa62f76d417e7e144` |
| `supabase/proposals/x149_xero_launch_hold.sql` (149 source) | `d45ed32a4fdce81713a99e207f92534f6ee1fc36edd4ef4f1da04a06112338e4` |
| `supabase/proposals/a150_ai_cap_key_off.sql` (150 source) | `30c31b23a0c582adde0af14f18de38c316f6ec14632ee0c7db811be377e903ef` |
| `supabase/proposals/p151_xero_invite_hardening.sql` (151 source) | `25fa2766b9a923bcc85ed0d642e2751f477589f1096f58c2288c28bf00b7bfc3` |

## 10. List of everything in this sheet marked NOT VERIFIED

- Owner actions: approval, approved SHA, hash comparison on the operator's machine, backup and restore point, correct project, quiet system, evidence table.
- Which baseline migrations (096 to 137) are on production.
- Order of app code deploy against SQL.
- Whether 144 fails cleanly without 107 (inferred, not run).
- Row counts of the verify files for 144 to 147, 149 to 151.
- Whether Tolra AI (146), job costing (148) are off by default beyond the column default and function names seen.
- Approvers for the rollbacks of 144, 145, 146, 150, 151 and (except the numbering note) 147.
- Hashes and content of the `supabase/cutover/*.sql` scripts and the "C16 runbook".
- Whether the importer refuses to write before 140/141 are applied.
- Whether `tests/rehearsal/upgrade.test.ts` covers releases 138 to 144.
- Production restore procedure; production query-running tool.
- Content of docs absent from the tree (`docs/RELEASE-CHECKLIST.md`, `docs/RELEASE.md`, `docs/MIGRATIONS.md`, `Tolra Progress.md`).
- Everything that exists only on other branches.
- Any CI result (none is claimed).
