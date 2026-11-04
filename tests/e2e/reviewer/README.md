# Reviewer browser and real-API checks (V)

Ten new Playwright cases cover the remaining reviewer gaps. They use real app routes, local PostgREST/database policies, local Auth and browser screens. Only outside providers are faked. They have NOT run with a database here; the no-database path was exercised and all ten skipped. Do not record skips as passes.

This branch uses #227's browser helpers and P/#238's updated click checklist (P is now merged into #227). It does not combine application features. The test application must separately contain the reviewed paid-break/setup/email combination (#236 plus setup access fix #239), chasing (#233 plus S/#241), accounting (#237 plus #240), and AI/caps (#234). Include the offline font fix (#242) when building without Google access. Missing features fail once a test backend is configured; no endpoint/table failure is converted to a skip.

The database owner must separately prepare and review the required numbered schema and N2/N5 proposals on a disposable backend. This suite never applies migrations/proposals. Reuse `tests/BLOCKED-DATABASE-CHECKS.md`, existing global setup/cleanup and loopback identity checks. Never point it at production, a hosted Supabase project or a real provider account.

```sh
# With no TEST_* configuration and no .env.test.local: clean skip, no backend/server is started.
npx playwright test -c playwright.reviewer.config.ts
# On Code's independently prepared disposable backend: missing DB is an error, never a green skip.
REVIEWER_REQUIRE_DATABASE=1 npx playwright test -c playwright.reviewer.config.ts
# Collection only:
npx playwright test -c playwright.reviewer.config.ts --list
```

Only complete absence of configuration is optional. Partial or unsafe configuration fails using the existing isolation guard. The strict default `playwright.config.ts` is unchanged. Do not delete its fail-closed setup or relax checks to get these specs running.

The runner adds `tests/support/reviewer-provider-mocks.cjs` after the existing outbound network guard, for these test servers only. It refuses a non-loopback backend. Sage/QBO synthetic OAuth codes return synthetic per-company tokens; their data endpoints reject a mixed provider/tenant and all writes. Other external traffic remains blocked. No credentials or real registrations are needed. Each run gets an ephemeral encryption key, never committed or printed. Accounting checks independently decrypt stored AES-GCM values with the correct company/provider and require failure with either changed.

The uncertain-email fixture records one fake local send, then returns a synthetic provider 500 so the app cannot know it arrived. The test requires unknown/needs-checking and no subsequent attempt. It does not mock Tolra's approval, recording or claim endpoints. The double-send fixture briefly delays the local provider so the real claim is exercised.

`V-INBOUND` runs the existing authenticated intake procedure and verifies both the invoice fields and payment ledger remain unchanged. As documented in S, the current branch has no separate paid-reply classifier; its normal intake RFQ is retained.

The real AI near-cap race already has `tests/db/tolra-ai-cap-concurrency.test.ts`, which forces two independent connections to contend. This browser addition tests owner-only cap controls; it does not replace that concurrency proof. Key/mode browser checks already exist in `tests/e2e/n1-n6/n2-tolra-ai.spec.ts`; run the existing N1–N6 runner too. Keep their results separate.

Every new case has its own entry in `tests/MANUAL-CHECKS-N1-N6.md`. Record exact commit, role/company, expected and actual result, PASS/FAIL/NOT RUN and private evidence. Synthetic browser traces may contain local session cookies; keep completed traces private. No SQL, seed writer, database checks or external provider calls were executed while writing these specs.

## AG: required integration runner

This PR now targets #247's candidate branch and includes its application, release packaging and #239/#240 fixes. The local combination had no conflicts. The assumption is that reviewer-browser changes must be reviewed against the candidate they exercise, rather than dragging feature code into a browser-only diff against #227. No GitHub merge was performed.

The CI integration job runs this exact command after preparing the disposable backend, baseline/full database suite, upgrade rehearsal, 145/146 release phases and build:

```sh
REVIEWER_REQUIRE_DATABASE=1 E2E_SKIP_BUILD=1 npx playwright test -c playwright.reviewer.config.ts
```

Missing database configuration is a hard error in CI. Every one of the ten cases is collected by this runner, with the required release schema and application present. The ordinary runner delegates only reviewer/ cases to this explicit step, avoiding a duplicate run without their provider setup; no case is dropped. The reviewer config clears that delegation ignore for its own run. The step reports even if an earlier check failed, unless cancelled; failures still keep the job red. The existing integration trigger/Ready-label policy is unchanged; this agent adds no Ready label and dispatches no SQL job.

Local validation collects all ten; it does not prove runtime. Code must run the integration job against the disposable backend. No SQL was applied or real provider called here.
