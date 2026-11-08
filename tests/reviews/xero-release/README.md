# Xero OFF and release verification

PR #415 at **e42d927383513d1b98ce9cfca444884475622e2f**, reviewed independently on `codex/xero-off-release-verification` (draft #419). Verification only. The candidate branch, application and production were not changed.

**Result: OFF enforcement passed. Release and guarded rollback rehearsal passed. Do not treat this as Xero release approval: #396's missing read-back protections reproduced 14 failures.**

## Results and exact commands

Commands below ran from this review worktree unless a different directory is stated. The candidate was extracted with `git archive e42d927383513d1b98ce9cfca444884475622e2f` to `/workspace/work/xero-candidate-snapshot`, not checked out on Code's branch. `XERO_REVIEW_ROOT` can select that archive in the supplied configurations.

| Check | Command | Passed | Failed | Skipped | Receipt |
| --- | --- | ---: | ---: | ---: | --- |
| Candidate Xero units, including engine, hold, route, mid-run, batch and setup-card tests | From candidate archive: `/workspace/tolra-public/node_modules/.bin/vitest run -c /workspace/work/xero-off-release-verification/tests/reviews/xero-release/candidate.config.ts --reporter=json --outputFile=/tmp/xero-candidate-unit.json` | 200 | 0 | 0 | `evidence/candidate-unit.json` |
| Real SQL and actual send routes over disposable PostgreSQL, with stub Xero | `node tests/reviews/xero-release/release-run.mjs` | 35 | 0 | 0 | `evidence/database.json` |
| #396 read-back regressions against this candidate | `node_modules/.bin/vitest run -c tests/reviews/xero-release/companion.config.ts --reporter=json --outputFile=tests/reviews/xero-release/evidence/companion-readback.json` | 2 | 14 | 0 | `evidence/companion-readback.json` |
| Review-file lint | `node_modules/.bin/eslint tests/reviews/xero-release/*.ts tests/reviews/xero-release/*.mjs` | exit 0 | 0 | — | No lint output |

The 35 database tests are the unchanged candidate's `tests/db/xero-launch-hold-149.test.ts` (20) and `tests/db/xero-launch-paths-149.test.ts` (15). They are not additional to another reported database subtotal. Total cases here: **237 passed, 14 failed, 0 skipped**. Companion tests are copied unchanged from #396 head `638a12c5fcd494597e1e99da95d77bb430256195`, `tests/unit/xero-readback-safety.test.ts`; the copy is a regression probe, not a production fix.

## Connected is separate from On

Connected means a Xero authorisation exists. On means the company's transfer hold is enabled **and** the connection is connected. Existing companies are inserted OFF at install; a new company without a hold row reads OFF. Connecting, reconnecting, consent, changing tenant/external connection or disconnecting resets OFF. Token refresh alone preserves an explicit On decision.

An admin must deliberately enable transfers after mapping; company isolation, support-session refusal, normal MFA and a fresh authenticator code where required are enforced by SQL. Nobody using an API role, including the service role, can directly write the hold table. UI status is server-read, not assumed from Connected.

All paths below passed OFF refusal in the candidate tests. Files and lines refer to the pinned candidate, not main.

| Path | Enforcement and evidence |
| --- | --- |
| Existing/new companies and connection changes | `supabase/proposals/x149_xero_launch_hold.sql:19` (table/default), `:29` (existing companies), `:32` (effective gate), `:120` (reset trigger); database hold tests exercise installation over connected companies, new companies, reconnect, fresh consent, tenant change, disconnect and refresh |
| Admin status and deliberate On | `app/api/integrations/xero/launch/route.ts`; `components/integrations/xero-setup-card.tsx:90`; SQL `:71`; unit launch-route and setup-card tests plus both database suites |
| Manual Send now | `app/api/integrations/xero/send/route.ts:29` → `lib/integrations/server.ts:114` → effective gate before tokens/engine; database paths test |
| After issuing a document | `app/api/integrations/xero/after-issue/route.ts:34` → same `sendQueued`; database paths test issues an invoice while OFF and proves pending, no outbound call |
| Retry and direct SQL claim | `supabase/proposals/x149_xero_launch_hold.sql:146` and `:236`; hold suite proves refusal before queue mutation, paths suite also calls the SQL directly |
| Batch enqueue/retry/send | `lib/integrations/xero/batch-deps.ts:43`, `:55`, `:88`; actual batch route exercised by database paths suite, mocked hold unit tests also prove enqueue/retry untouched |
| Daily and standalone cron | `app/api/cron/daily/route.ts:36` and `app/api/cron/xero-sweep/route.ts` call `lib/integrations/xero-pass.ts`; `lib/integrations/server.ts:233` lists only enabled connected companies and `:239` rechecks before renewal; paths suite executes the shared sweep body, unit tests cover absent-149 skip handling |
| Contact/invoice/credit/void/read-back and mid-run OFF | `lib/integrations/xero/launch-hold.ts:33` wraps every provider method; `lib/integrations/server.ts:83` gates token work; `lib/integrations/engine.ts` handles `TransfersHeldError`. Unit tests cover all methods, and database paths tests switch OFF after contact lookup and while a write is in flight |

OFF stops the next outbound call. An HTTP write already dispatched cannot be recalled; its genuine result is still recorded. The tests explicitly prove that limit, rather than promising instant cancellation. No transfer bypass while OFF was found in this focused review. Connection setup, mapping reads and disconnect/revoke remain available while transfers are OFF; this switch is not a promise of zero Xero traffic for those explicit administration actions.

## Outstanding companion PRs

| PR / reviewed head | Missing safeguard or difference in #415 | Required handover |
| --- | --- | --- |
| #396 `638a12c5fcd494597e1e99da95d77bb430256195` | **Missing, reproduced.** `lib/integrations/xero/client.ts:36` invents zero for missing totals; `:134` selects ambiguous matches, accepts a purchase credit as sales credit, and treats malformed lists or missing identity/type as no match. Fourteen regression failures cover these cases; only the two valid exact-match controls pass. A retry can trust an unsafe reconciliation answer. | Code must integrate the read-back corrections, preserve 149's provider wrapper, and rerun these probes and the hold/path tests at the resulting SHA. Do not enable Xero based on this review. |
| #403 `5680410b26c07f7bdf107b216b37f85770b6f494` | Core OFF gates are represented by a different implementation. #403 adds `integration_connections.transfers_enabled`; #415 uses a private `xero_transfer_hold` table. **#403's queue-insert suppression is not present**: #415 deliberately queues documents issued while held, retains old pending rows and makes them eligible once On. This is tested behaviour, not an OFF bypass. #415 additionally checks mapping/fresh MFA and handles mid-run OFF explicitly. | Decide and explain the held-period backlog before enabling. Do not apply both versions of 149 or use #403's column-based sweep with #415's table-based release. Its `supabase/migrations/149_xero_launch_hold.sql` is not interchangeable with #415's one-time release wrapper. |
| #408 `06972f89b69faf044d9bb18e4083f9fe84c9fbe7` | Shared `lib/integrations/mapping-rules.ts` extraction and adapter-owned void policy are absent. #415's engine still imports Xero mapping/void rules directly. This is an outstanding common-accounting change, not a newly identified Xero OFF bypass. | An engine replacement from #408 would remove #415's `TransfersHeldError` handling. Reconcile the changes, retain the hold wrapper/token gate and pending result handling, then rerun tests. No second provider was tested. |

## Disposable release and rollback

`release-run.mjs` hardcodes loopback port **54849**, test user `xero_test`, creates a random `xero_verify_...` database and drops it in `finally`. It needs an already-started disposable PostgreSQL 17 cluster with that test superuser; it accepts no external database URL. This run used PostgreSQL **17.6**. `bootstrap.sql` supplies minimal Auth/Storage schema, roles and Supabase service-role default privileges; explicit migration revocations still apply. This is not a running Auth, Storage or PostgREST service. `paths.setup.ts` substitutes SQL-based synthetic Auth/admin fixture creation; it does not replace the routes, SQL, engine, provider stub, role/JWT simulation or isolation guard. No real users, keys, documents or provider requests were used.

The runner applies every numbered baseline migration through 137, then checks `supabase/release-plan.json` matches exactly **138 → 140 → 141 → 143 → 144 → 145 → 146 → 147 → 149 → 150**. Each release and every boolean row in its companion verification passed; every final release marker was applied. Baseline/apply/verify/rollback SQL paths and SHA-256 hashes are in `evidence/release-run.json`.

Reverse rollback passed **150 → 149 → 147 → 146 → 145 → 144 → 143 → 141 → 140 → 138**. Important stop points:

- 149 rollback first refused a connected company held OFF. Removing this SQL guard can restore old sending behaviour. The test explicitly accepted that risk only inside its disposable database to complete the reverse-chain rehearsal. That acceptance is not a production instruction
- With this candidate app and 149 absent, sending fails closed and the sweep reports skipped; the actual paths test proved this against PostgreSQL
- 146 rollback retains request history and its `key_source` column. Reapplying 146 immediately after its rollback refused with `column "key_source" ... already exists`; do not rerun 146 after rollback
- Comparing public/security_audit function definitions and column type/null/default hashes before releases and after all rollbacks: 1,701 baseline entries restored unchanged; only `public.ai_helper_requests.key_source` remained added, deliberately. This comparison does not claim a complete byte-for-byte schema, data or grant restore
- Production apply command for 146 remains `psql -v ON_ERROR_STOP=1 --single-transaction -f supabase/release/146_tolra_provided_ai.release.sql` after the approved prior steps. Nothing here applied it to production

## Handover

**Done:** focused review of the requested SHA; Connected/On/default/OFF paths, mocked unit and real SQL/path tests; comparison with all three companion heads; full requested apply/verify/reverse rollback rehearsal; refusal and retained-history checks; evidence committed and pushed to draft #419; plain-English PR summaries.

**In progress:** none in this verification job.

**Not started / next owner:** Code's integration of #396, reconciliation with #403/#408 and rerun against any new candidate SHA. Full browser/Supabase HTTP, hosted deployment and live provider acceptance were outside this verification and remain unproven. No merge, production SQL or human release approval was performed.
