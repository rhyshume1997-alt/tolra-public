# AI READY FOR KEYS: builder 3 implementation and handover

Scope: main `68f89ca7b801a10587ff9b51d6c820462847b65a`, new branch `codex/ai-ready-for-keys`. Uses #395 as evidence of the existing SDK implementation, not as a branch to modify. No #359, go-live or other agent branch is changed. No live provider call, real data, production SQL, activation, deployment, merge or message to John.

The provider, request log, cost ledger, company switches, validators and human-review paths already existed. This change completes configuration while OFF and hardens response accounting/timeouts. It introduces no AI framework, second chatbot or alternative uncapped path.

## Approved workflow inventory

“DONE” below means wired in code and covered with synthetic/mock tests, not connected, deployed or live accepted. Scope comes from `components/ai-helper/master-card.tsx` (`FEATURE_LABELS`) and `lib/ai-helper/assistant.ts` (`ASSISTANT_DRAFT_KINDS`). There is no remaining missing wire in those approved workflows. Drawings/attachments and automatic consequential actions remain outside this approved implementation.

| Workflow | UI → existing route → implementation | Human boundary | Code status |
|---|---|---|---|
| RFQ email reading | `components/ai-helper/rfq-panel.tsx` → `app/api/ai-helper/rfq/route.ts` → `lib/ai-helper/server.ts`, `anthropic.ts`, `rfq.ts` | Pasted text only; bounded validated suggestion, missing fields flagged, no model price | DONE |
| RFQ suggestion to draft quote | same panel → `app/api/ai-helper/rfq/decision/route.ts` → `lib/ai-helper/approve.ts`, `pricing.ts` | Separate authenticated human Approve; stored suggestion re-read under company RLS, re-priced deterministically, draft only; no send/issue/payment | DONE |
| Daily/weekly round-up | `components/ai-helper/roundup-panel.tsx` → `app/api/ai-helper/roundup/route.ts` → `lib/ai-helper/roundup.ts`, `server.ts` | Read-only dashboard facts; unchecked numeric wording dropped; no records means no model call | DONE |
| Assistant questions about quotes/jobs | `components/ai-helper/assistant-panel.tsx` → `app/api/ai-helper/assistant/route.ts` → `lib/ai-helper/assistant-load.ts`, `assistant.ts`, `server.ts` | Caller session/RLS; scoped read-only summaries, customer aliases, only server-approved record links | DONE |
| Assistant email draft | same assistant path; draft kind `email` | Human reads/edits/copies and uses existing send approval; assistant cannot send | DONE |
| Assistant internal note draft | same assistant path; `note` | Human copies/saves through an existing authorised screen; no automatic save | DONE |
| Assistant quote wording | same assistant path; `quote_wording` | Human reviews/uses wording; no AI price or quote acceptance | DONE |
| Assistant RFQ clarification | same assistant path; `rfq_clarification` | Human reviews/copies; no automatic customer-facing write/send | DONE |
| Check before issue | `components/ai-finance-check-panel.tsx` → `app/api/ai/finance-check/route.ts`, `decision/route.ts` → `lib/ai/finance-check/` | Existing deterministic check, not an SDK/model call. Zero AI cost; human decision is recorded separately; it never issues the document | DONE |

All three paid model features reserve from the **same company/month usage row** before the provider/key is used. RFQ and roundup use `ai_helper_reserve`; assistant uses `ai_helper_reserve_assistant`; both settle through the existing service-only `ai_helper_settle`. Deterministic finance checking consumes no provider tokens and needs no spending reservation. `lib/ai-helper/anthropic.ts` is the sole SDK call site. No live provider is added elsewhere.

## Changes and accounting

- Existing `/ai-helper` and the Settings pointer are visible to admins while the server is OFF. Configuration status, company features, key-present/not-configured, monthly cap, spent and reserved pence are shown. Key presence is explicitly not a connection test. Office users retain read-only configuration only while the helper is enabled; support/workshop/viewer cannot configure it.
- Existing admin key/settings routes can prepare encrypted company credentials/settings while provider routes remain globally OFF. Same-origin, authenticated admin, support refusal and database MFA/company checks remain. No configuration action calls a model. Provider/decision routes retain their original exact-`true` global gates. Existing backend/service-role and encryption readiness are reported only as booleans/messages, never secret values.
- SDK schema requests and existing workflow validators remain. Missing, negative, fractional, non-finite or impossible token counts, an unexpected model or usage over the reserved budget cannot become a free/undercharged successful answer. Unknown provider names and deployed mock selection fail closed.
- The SDK still has 30-second timeout and zero retries. The shared helper also bounds a stuck adapter at 30 seconds. A timeout/uncertain billed attempt is charged at the reservation; a certain rejection before work costs zero; usable known usage is charged using the existing conservative pence calculation. No automatic retry is introduced.
- Successful token counts are stored alongside the validated output in the existing request row (`output.usage`); monetary cost remains in the existing request/usage ledger and audit. Failed output remains NULL, as required by migration 133; known failed usage still determines its existing cost field. No raw provider error, unvalidated answer or key is stored/returned. A settlement failure hides the suggestion and retains the held reservation for 133's existing stale-charge behaviour.

## Rhys's cap decision: 1000p, per company, all paid paths

This is implemented, not an open question. `supabase/proposals/ai_ready_for_keys.sql` replaces the separate own-key **default** of 500p with **1000p (GBP 10)** in the existing settings column and no-row status response. It does not introduce another cap table. RFQ, roundup and assistant, including own-key calls, all continue to use that one per-company setting and existing month ledger. Only the company's admin sets it, 0–100000p; it cannot go below spent plus held reservations. Off is a switch, not cap exhaustion.

New/no-settings companies get 1000p. Already saved custom values, existing usage, keys and switches are preserved; an existing intentional 500p/0/custom cap is not silently reset. The admin can explicitly set that company's cap to 1000p using the existing setter. No company is enabled by this proposal.

The proposal adds settings-row locking before usage-row locking in both reserve functions and the setter, so a cap reduction cannot race a request using an old cap. Its guards accept only the exact main 122/101/133/134 bodies or its own reviewed bodies; it refuses an unknown target. It is unnumbered to avoid colliding with held/release work. Original numbered migrations, release files, release plan and go-live branch stay unchanged. **It was applied only to an empty disposable test database.** Production application/packaging still requires its own review and authority. Companion read-only check: `supabase/verify/ai_ready_for_keys.sql`; every row must be true. Do not apply it blindly to a release-146 candidate with different function bodies.

## Reproducible evidence

Final counts and commands are in `tests/reviews/ai-ready/RESULTS.md`. Logs in its `evidence/` folder contain synthetic data/test names only. Main's shared package installation was reused without changing dependencies or the lock file.

The standalone DB runner needs an operator-created empty database named `ai_ready_test_*` on literal loopback. It refuses other hosts/names and a populated schema. `tests/ai-ready/bootstrap.sql` supplies minimal **test stand-ins** for auth/session/audit prerequisites. It then loads the actual 101/103/122/133/134 AI migrations, actual RLS/grants and this proposal into real PostgreSQL 17.6. Concurrent tests use separate physical sessions and observe a real database lock wait. This proves these AI database boundaries/arithmetic on that fixture, not the full Supabase session/JWT framework or a hosted production installation. No DB/backend test is silently converted to a mocked pass.

`node tests/ai-ready/database.mjs` uses `AI_READY_TEST_DATABASE_URL`, e.g. `postgresql://ai_test@127.0.0.1:55439/ai_ready_test_final`, solely for the disposable local runner. The binary was obtained outside the repo from `@embedded-postgres/linux-x64@17.6.0-beta.15`; this is test tooling, not an app dependency. Hosted Supabase/browser/provider acceptance is not executed.

## Exact external configuration still needed

These are deployment/operator requirements, not actions authorised by this PR:

1. Review the actual deployment version and package/authorise the SQL proposal against its correct database state. Check 101/103/122/133/134 prerequisites and every companion verify row; preserve existing switches/usage. Do not mix its evidence with #359 or a go-live release head.
2. Configure the existing Supabase environment for the intended isolated/deployed app: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`. Keep the existing valid 32-byte base64 `INTEGRATIONS_ENCRYPTION_KEY`; do not rotate it casually or existing encrypted integrations/keys become unreadable.
3. Set `AI_HELPER_PROVIDER=anthropic` (or leave unset for its existing default). Never deploy `mock`. In the existing AI configuration screen, the authorised admin supplies **that company's own Anthropic API key** and uses the per-company cap (1000p default), plus an account-side spending limit. No credential was supplied, requested, stored or tested against a real provider here.
4. Before authorised activation, confirm that account supports the currently pinned model IDs `claude-opus-5-5` (RFQ) and `claude-sonnet-5-5` (roundup/assistant), effort/structured JSON output and the price assumptions in `lib/ai-helper/limits.ts` (USD/MTok input/output: 4/20 and 2/10). This PR does not establish live model availability/pricing/exchange-rate coverage. A model/price change requires a reviewed update to that existing table/estimate and affected tests; do not guess or select an unpriced model. Allow enough function runtime for the 30-second provider deadline plus settlement.
5. **Keep `AI_HELPER_ENABLED=false`, `AI_ASSISTANT_ENABLED=false`, `AI_FINANCE_CHECK_ENABLED=false` for this delivery.** Provider routes stay OFF. Later activation needs explicit authority, company approval for sharing/retaining the allowed data, deliberate per-company feature choices, same-version hosted RLS/browser checks and separately authorised provider acceptance. Key present never means connected or live verified.
6. Existing retention remains 12 months through migration 133 and `/api/cron/nightly` → `/api/cron/ai-helper-purge`; configure the existing server-only `CRON_SECRET`/nightly scheduler for the intended deployment. No new retention system is created.

## Status and handover

- **CODED:** yes, approved workflows wired; missing readiness/accounting/default-cap work completed in this branch.
- **TESTED:** mock SDK/API/unit tests plus real disposable PostgreSQL AI RLS/ledger/concurrency checks; see exact counts/limits in RESULTS.md.
- **READY FOR KEYS:** implementation ready for reviewed configuration; production requests remain OFF. It does not mean the SQL proposal has been installed in production or model/account acceptance is proven.
- **CONNECTED:** no. **MERGED:** no. **DEPLOYED:** no. **LIVE VERIFIED:** no.
- **DONE:** this bounded implementation/test task; external setup, approval and rollout are not done.

**Done:** implementation, workflow inventory, synthetic evidence, type/lint checks and new-branch draft PR with this handover. **In progress:** independent review and authorised operator configuration. **Not started:** real credentials, live provider/model test, hosted end-to-end acceptance, production SQL, feature activation, deployment or merge. No action is sent to John. Original owner branches remain untouched.

Repo note: main does not contain the older `tests/HANDOVER-CODEX-1.md` or `docs/TOLRA-WORK-OWNERSHIP.md`. Root AGENTS.md was read; installed Next 15 lacks the prescribed `node_modules/next/dist/docs/` directory, so the upstream Next 15 route-handler reference was read before route edits. This task remains on its own branch from main.
