# Database and browser checks for Claude Code / CI

All database, Docker, migration execution, upgrade, rollback and live-provider checks below are **BLOCKED / NOT RUN by codex2**. Unit tests, TypeScript, lint and a browser run that skipped for missing configuration are separate evidence. None proves database behaviour.

## Rules and evidence

Run only on a disposable CI runner's local Supabase. Never use a hosted database, production keys, `supabase link`, `supabase db push`, or a real customer mailbox. SQL proposals and rollback scripts still need review before anyone executes them. The commands below are a handoff, not authorisation to apply production SQL. No SQL was applied while writing this document.

Record the commit SHA, backend identity, commands, exit codes, exact passed/failed/skipped counts, SQL verification output and Playwright artifacts. A skipped browser test is **not** a pass. Do not weaken assertions, rewrite a catalogue snapshot to hide a failure, add Ready labels, merge a PR or deploy to obtain evidence.

Use Node 22, the lockfile, Docker, Supabase CLI 2.40.7, PostgreSQL client tools and Chromium on the runner, as in `.github/workflows/ci.yml`. CI's existing integration job is gated on a `ready` label for PR events. **Do not add that label.** A manual `workflow_dispatch` run bypasses that label requirement.

For the two-column read-only verification files below, a successful `psql` exit alone is insufficient: a false result must fail CI. Put this helper in the same Bash step as the verification commands (or source it in each such step):

```sh
set -euo pipefail
verify_sql() {
  psql "$TEST_DATABASE_URL" -XAt -F '|' -v ON_ERROR_STOP=1 -f "$1" |
    awk -F '|' '{print} NF != 2 || $2 != "t" {bad=1} END {exit (bad || NR == 0)}'
}
```

## D — chase line (migration 138)

The updated branch is `codex2/chase-main-update`, targeting `chatgpt2/chase-customer-review-code-only`. It contains the original 138 migration, release, rollback, verification, catalogue fixture and chase database/browser tests. Only the approval banner wording conflicted with main; its resolution does not replace database evidence.

Claude Code can dispatch the existing CI workflow, without a Ready label:

```sh
gh workflow run ci.yml --ref codex2/chase-main-update \
  -f skip_db=false -f specs=tests/e2e/chase-steps.spec.ts
```

Expected: the database suite and upgrade rehearsal actually run, then every chase browser case runs and passes. No missing-backend skips. Save the Actions run URL. This command is listed only; codex2 has not dispatched it.

Equivalent steps inside that disposable runner:

```sh
npm ci
npm run check:migrations
npm run test:backend
set -a
. ./.env.test.local
set +a
npm run test:db
npx vitest run -c vitest.db.config.ts tests/db/chase-steps-138.test.ts
verify_sql supabase/verify/chase_steps_138.sql
scripts/upgrade-rehearsal.sh 013
npx playwright install --with-deps chromium
npx playwright test tests/e2e/chase-steps.spec.ts
```

Expected: migration-file checks pass; every database case passes (including RLS, role/support refusal, draft uniqueness, pause and request claims); all 12 chase verification rows are true; the upgrade applies twice with the expected catalogue; chase browser tests pass. Duplicate-name draft creation and stale reviewed-text approval must still be refused. The existing tests are the acceptance criteria, not merely a successful SQL paste.

## F — assemble the features before running their browser specs

`codex2/n1-n6-browser-checks` contains tests and handoff files, not copies of #218–224's application changes. Use a throwaway CI checkout containing the reviewed feature heads. Do not push this assembled branch to main. For example:

```sh
git fetch origin main:refs/remotes/origin/ci-main
git switch -c codex2/ci-n1-n6-evidence origin/ci-main
# Fetch explicitly because some checkouts track only origin/main.
git fetch origin codex2/chase-main-update:refs/remotes/origin/ci-chase
git merge --no-ff --no-edit origin/ci-chase
for pr in 218 219 220 221 222 223 224; do
  git fetch origin "pull/$pr/head:refs/remotes/origin/ci-pr-$pr"
  git merge --no-ff --no-edit "origin/ci-pr-$pr"
done
git fetch origin codex2/n1-n6-browser-checks:refs/remotes/origin/ci-browser
git merge --no-ff --no-edit origin/ci-browser
npm ci
npm run check:migrations
```

Stop if a merge conflicts; resolve it explicitly and record the files. In particular retain both release-preflight markers if 138 and 144 overlap. Do not use a blanket ours/theirs resolution. Pin and record all fetched SHAs; later PR updates require fresh evidence.

### Baseline database and upgrade checks, before optional proposals

```sh
npm run test:backend
set -a
. ./.env.test.local
set +a
npx vitest run -c vitest.db.config.ts \
  --exclude tests/db/company-setup-isolation.test.ts \
  --exclude tests/db/tolra-provided-ai.test.ts
scripts/upgrade-rehearsal.sh 013
```

Expected: all ordinary database and upgrade cases pass, zero failures/skips. The two excluded proposal proofs run in the next phase, after their reviewed prerequisites; they are not waived. Starting/rebuilding the local stack applies numbered migrations only, including 138/144 in this assembled checkout. It does **not** apply `supabase/proposals/` files.

### N5 and provided-AI proposals and dedicated proofs

After review, on that same disposable database only:

```sh
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/proposals/n5_company_setup.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/proposals/n2_tolra_provided_ai.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';"
verify_sql supabase/verify/n5_company_setup.sql
verify_sql supabase/verify/n2_tolra_provided_ai.sql
npx vitest run -c vitest.db.config.ts \
  tests/db/company-setup-isolation.test.ts tests/db/tolra-provided-ai.test.ts
```

Expected: every verification row is true; both database proofs pass. New companies cannot read/write another company's progress or read its customers. Provided AI is globally and locally off by default; only the service role can retrieve its ciphertext, and only for a reserved provided-mode request in the stated company. Two 400p reservations fit a 1000p allowance; the third is refused. Another company starts with separate usage; disabling the service refuses new reservations. Plaintext keys never enter storage.

The supplied N2 database proof tests the cap sequentially. A real concurrent-reservation proof is still missing: Code must extend `tests/db/tolra-provided-ai.test.ts` with separate connections racing against one company's cap, verify total reserved/spent never exceeds it, and rerun the same command. The SQL uses one guarded UPDATE, but a source assertion or sequential success is not concurrent execution evidence.

The N2 proposal deliberately refuses unexpected 133/134 reserve bodies. Investigate that failure rather than deleting the guard. It wraps public AI functions while preserving their original bodies under private names, and adds reviewed schema objects. Old catalogue/hash checks belong to the **pre-proposal** phase; do not run them after the proposal and weaken them to make them green. The dedicated N2 verification checks the preserved bodies. The final numbered-release catalogue and upgrade path for these optional proposals remain a separate release-review step.

### N5 / N6 / N2 browser checks

```sh
npx playwright install --with-deps chromium
N1_N6_REQUIRE_DATABASE=1 npx playwright test -c playwright.n1-n6.config.ts
npx playwright test tests/e2e/email-templates.spec.ts tests/e2e/chase-steps.spec.ts
```

Expected: all **8 new specs run**, zero failures and zero skips; the existing template and chase cases also pass. The existing template tests retain their exact saved-text/default/preview assertions through an input adapter for both old and new editors. No existing test was marked skipped for this work.

The new runner uses the existing guarded app servers, synthetic two-company setup, mock email/AI providers and no-outbound-network guard. It enrolls a synthetic owner's authenticator, uses a synthetic provider key, then checks key secrecy, company choice/isolation and a hard cap. No live model or billable provider is needed. Cleanup clears the test's global provider state, including its synthetic owner reference.

Without any test database configuration, this safe local command must instead collect and skip all eight cases before starting a browser, app server or global setup:

```sh
npx playwright test -c playwright.n1-n6.config.ts
```

That is the only browser execution validated by codex2 here. A partially configured or unsafe backend is an error, not a skip. With `N1_N6_REQUIRE_DATABASE=1`, absence is also an error. The ordinary `playwright.config.ts` remains fail-closed and unchanged.

### Proposal rollback rehearsal (separate disposable copy)

After the tests, retain usage/request counts and export the verification output. On a **separate disposable copy**, review and run:

```sh
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/n2_tolra_provided_ai.rollback.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/n5_company_setup.rollback.sql
verify_sql supabase/verify/ai_helper_pre_enable_133.sql
verify_sql supabase/verify/ai_assistant_134.sql
```

Expected: N2 refuses rollback if a provided request is still reserved. Settle test reservations first and rerun. A successful N2 rollback restores original own-key functions/grants, switches off formerly provided-mode companies and preserves usage/request history plus the source column. N5 removes setup ticks only, leaving company data intact. Record the before/after counts. The retained source column means this is not a promise that a pre-proposal schema snapshot matches byte for byte, or that the one-time proposal can be reapplied unchanged.

Rehearse 138 rollback/release on its **own fresh disposable copy** using `supabase/release/138_chase_steps.rollback.sql` then `supabase/release/138_chase_steps.release.sql`; run `tests/db/chase-steps-138.test.ts` and `supabase/verify/chase_steps_138.sql` again. Expected: refusal guards work with incompatible/outstanding data; a clean rollback/release restores passing chase checks. Never force a guarded rollback through.

```sh
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/138_chase_steps.rollback.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/138_chase_steps.release.sql
npx vitest run -c vitest.db.config.ts tests/db/chase-steps-138.test.ts
verify_sql supabase/verify/chase_steps_138.sql
```

## Remaining blocked database work from earlier codex2 jobs

Run each branch's matching numbered migrations on a fresh isolated stack, not against an unrelated PR's schema. These checks were not covered by unit-only results or the old #160–177 unit matrix.

| Item | Exact command on the named branch | Expected result |
| --- | --- | --- |
| All ordinary RLS, auth, role, email, quota, money/payment and catalogue checks on any tested head | `npm run test:backend` then `npm run test:db` | All cases execute and pass; no hosted backend; no waived failures. Proposal heads use the two-phase procedure above. |
| Older-chain upgrade / repeatability on each integrated numbered chain | `scripts/upgrade-rehearsal.sh 013` | Upgrade and second application match the intended fresh catalogue; no data leakage/loss. |
| #191 chase join (including #172/#154/#189) | On `codex2/chase-join`: `npx vitest run -c vitest.db.config.ts tests/db/chase-steps-138.test.ts` and the branch's `supabase/verify/chase_steps_138.sql` via `psql -X -v ON_ERROR_STOP=1 -f` | Scoped draft creation, exact-text claim/approval, payment-claim and repeated-send protections pass. Its verify files must match its reviewed function versions; report any disagreement. |
| #192 timesheet schedule/day maths | On `codex2/e13-more-tests`: `npx vitest run -c vitest.db.config.ts tests/db/email-schedule-weekdays-142.test.ts tests/db/time-attendance.test.ts tests/db/time-week-race.test.ts` | Day storage, tenant boundaries and concurrent week/time operations pass. The invalid-seconds regression remains in the unit suite. |
| #193 / #181 SliQ import and release preflight | On `codex2/sliq-more-tests`: `npx vitest run -c vitest.db.config.ts tests/db/sliq-import.test.ts tests/db/sliq-import-preflight-140-141.test.ts` | Transactional synthetic imports, rollback, uniqueness and preflight guards pass; unsafe numbers are refused. No real import is authorised. |
| #190 costing rates | On `codex2/costing-join`: `npx vitest run -c vitest.db.config.ts tests/db/costing-rates-143.test.ts`; `verify_sql supabase/verify/costing_rates_143.sql`; `psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f tests/scripts/costing-rates-143.proof.sql` | RLS/roles, whole-penny storage and machine labour overrides pass; all verification booleans true. SQL proof is reviewed first and runs only locally. |
| #190 optional atomic costing helper | Review `supabase/proposals/builder2_costing_settings_atomic.sql` on that branch, then `psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/proposals/builder2_costing_settings_atomic.sql` | Compilation is only the first check. Runtime rollback/concurrent stale-save proof is still missing: Code must add a DB regression before claiming atomicity verified; see below. |
| N1 paid-break persistence | In the N1–N6 assembled checkout: `npx vitest run -c vitest.db.config.ts tests/db/time-attendance.test.ts tests/db/time-labour.test.ts` plus N1's manual click checks | Existing attendance/labour checks pass and the saved break choice survives reload per company. Passing the existing DB tests alone does not prove that new UI persistence. |
| N3 accounting migration 144 | In the N1–N6 checkout: `verify_sql supabase/verify/accounting_connections_144.sql`, plus the baseline DB suite before optional proposals | All verification booleans true; the baseline catches catalogue/definer/RLS gaps. Stop on a mismatch; do not overwrite the fixture to hide it. |
| Ordered #176/#177/#181/#182/#180/#189 integration dry run and #160–177 exact-head matrix | On each exact head recorded in the earlier reports: `npm run test:backend`, `npm run test:db`, `scripts/upgrade-rehearsal.sh 013`, `npm run test:e2e` | Full-stack evidence for that exact SHA. The earlier totals were **unit-only**; they do not prove migration compatibility or browser behaviour. Each different schema needs its own disposable reset/runner. |

Missing atomic-costing proof: add `tests/db/costing-settings-atomic.test.ts` on that costing branch, covering foreign-company/support/role refusal, fractional-penny refusal, a failed multi-table save leaving every table unchanged, and two simultaneous saves with the same expected snapshot producing at most one success. Then run `npx vitest run -c vitest.db.config.ts tests/db/costing-settings-atomic.test.ts`. Expected: all assertions pass. **That file does not exist yet; do not report this command as a completed check.**

The 138/140/141/142/143/144 release preflights, rollback guards and any resulting catalogue differences must be evaluated on their actual assembled chain. The earlier dry run resolved text conflicts only and did not apply any of these migrations.

## External-service checks remain separate

Real Xero/Sage/QuickBooks OAuth, test-account export/disconnect, Microsoft 365 and provider-key acceptance cannot be proved by the local database or mocked browser suite. Use the already-built #221 instructions in `tests/accounting/SETUP-AND-CHECKS.md` for approved accounting sandboxes. For Microsoft 365, supply the `MS_TEST_*` values listed in `tests/live/guards.ts` using CI secrets for the dedicated test tenant, then run `npm run test:live`; expected: authorised test mailbox succeeds and denied mailbox is refused. Never substitute a customer tenant, print keys or put them in this file. These sandbox checks stay blocked until those accounts/approvals exist; mocked success is not a substitute.

N4's validation record must link the actual outcomes: `node tests/validation/check-pack.mjs` checks pack structure on #220, not live behaviour. Copy the real database/browser evidence into the validation report only after the corresponding checks execute.
