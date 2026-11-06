# Builder 3 combined release handover

Draft test branch `codex/combined-release-151`, based on accepted #433 `147ac28e0b9343ba5b041fdb9956767c180671ce`. No candidate edits, provider activation, deployment, merge, production SQL or real data. All SQL runs are fresh synthetic PostgreSQL17.6 nonce databases; local Auth/Storage tables are stand-ins, not hosted Supabase/browser evidence.

Source provenance: #437 `396b887428023575802efe900601244b57bb916f` (SQL is identical to its earlier `6d147b9`; latest commit adds two atomicity tests), #436 `46e5c7abdbe367d891dbb4ec37e6d3c5ce354d8b` permissions tests extended to both new helpers and exact search paths; #438 `27062aea7f8d4fc6d0d8de5f20d4f615e77a95f3` pending revoke; #439 `c1dc028234bb5a9de58eefe339ee59e1ebb1032e` penny accuracy/historical snapshots; #440 `d6e45533e8dcc0ec8859c01e15d5f9984c3bc7e8` independent adversarial tests. Original six source PRs are recorded in `tests/reviews/integration/evidence/pr-map.json`.

Done: existing151 code issue/verify use wall time after locking invitation and bound company/creator authority; callback locks state then invitation and checks expiry, revocation and binding after waits; refusal correlation retained; preflight requires exact paths for all eleven functions and pins changed bodies. Draft151 rollback refuses used-but-pending OAuth and locks its guard against concurrent exchange. Neither new #437 helper body is modified. Applied numbered migrations, release registration/order,143 rates and149/150 definitions are unchanged.148 changes are precisely #439's reviewed half-up rounding; engine/goldens unchanged.

Failing-first adversarial:10 passed,6 failed,0 skipped. After existing151 corrections:14 passed,2 failed,0 skipped. Still BLOCKED: `expiry while the ordinary store waits on a connection lock must roll back the final connection` and `creator demotion during the ordinary store lock wait must prevent connection storage`, both SQLSTATE00000 wrong outcomes in #437 `integration_invite_store_connection`. See #440 reproduction and Code recommendations. Code owns these new helpers; do not rebuild them here. INV-03 name matching remains a PM policy decision: #437 now accepts differing trading names, whereas an older independent test requires refusal. No assertion is weakened to hide that disagreement.

Rollback tests:3 passed,0 failed,0 skipped. Before fix the first test proved pending consent did not stop rollback; later baseline failures were cascading fixture/schema errors, preserved separately. An interim test used nonexistent `costing_overhead`; corrected to actual143 tables. Reverse151/150/149 executes only with a synthetic held connection/document and tests149's refusal before using its explicit disposable-only override. No running sender exists. Reapply149/150/151 passes all active verifier rows and keeps transfers OFF/documents held. Separate financial suite proves nonempty historical cost snapshots remain frozen.

In progress: full unit/type/lint and combined143/148/149/150/151 SQL regressions, AI cap/key-removal, fresh eight-case real-Supabase Actions receipt. Commands/results and exact final SHA will be appended. No `INTEGRATION_VERIFY_BASE` is set: active checks must pass, not an old verifier. Workflow is restricted to this own branch/own base, no deployment permissions or production credentials. Mandatory IPv4/IPv6 outbound firewall plus response-stage local OAuth interception retained. Backend unavailable/skipped browser tests fail.

Accepted prior branch-only browser evidence: #433 SHA147ac28, https://github.com/rhyshume1997-alt/tolra-public/actions/runs/42162456124 :8 passed,0 failed,0 skipped; outbound restrictions active, reserved external probe rejected,1263 IPv4/3 IPv6 new external connections blocked. This does not prove this combined SHA. Earlier unsafe synthetic provider-redirect incident and correction are disclosed in #433 and its handover; no blanket provider/browser approval.

Not started: Friday read-only demonstration pack. Remaining source helper races and INV-03 decision prevent release approval regardless of passing browser/unit counts. Human approval/tester/signature fields must remain blank.

## Final local regression result

All commands run at this branch's final SQL/test source profile, with no baseline verifier override. Exact commands, exit statuses and raw JSON are in `evidence/suite-results.json` and `evidence/*-final.json`. Command pattern is `npx vitest run --config <config from that file> --reporter=json --outputFile=<recorded path>`.

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Independent437 adversarial |14|2|0|
| Standard149/150/151 + Sonnet helper tests + extended436 permissions |111|0|0|
| Reverse/reapply151/150/149 and missing150 stop |4|0|0|
|143/148 financial tests on full151 schema |34|0|0|
| Penny precision and nonempty old snapshots |49|0|0|
| Pending OAuth revocation, concurrency, company/MFA/support guards |11|0|0|
| Invitation identity/refusal/binding |37|1|0|
| Organisation picker |20|0|0|
|151 package permissions/rollback/verifier attacks |15|0|0|
| Direct lifecycle positive controls/OFF/held |8|0|0|
|151 file hashes and unique ordered registration |5|0|0|
| Independent own-key cap/key-off |24|0|0|
| Independent Tolra-provided cap/key-off |30|0|0|

Do not total these as unique scenarios: some test files are deliberately rerun on different schema profiles. Two implementation defects remain (inner-store expiry and creator-demotion races, SQLSTATE00000), plus one unchanged INV-03 policy assertion (different organisation name accepted versus older test requiring an explicit identity decision). No tests skipped or precision assertions weakened. These are **BLOCKERS**, not release approval.

The151 SQL guard also proved missing150 was incorrectly accepted (3 passed/1 failed before) and now refuses until150 is installed (4/4 after); comments now accurately distinguish plan registration from application. No registration/digest/history is silently changed. All four final151 bytes are pinned, and file-sha256.json records148/151/preflight bytes.

One existing test expected11 verifier rows; it now requires all14 rows and every row true. During the complete rerun,111 standard and34 financial assertions passed but their teardown failed because the minimal Auth stand-in lacked `auth.sessions -> auth.users ON DELETE CASCADE`. This was a test environment defect, not a passing run. The own `standard.setup.ts` now supplies that real Auth cleanup contract after creating its nonce database. Both reruns exited0 and every suite/teardown passed. No deployed Auth schema, grants or RLS was edited.

AI commands: `AI_CONTRACT_ADMIN_URL=postgresql://xero_test@127.0.0.1:54849/postgres AI_CONTRACT_MODE=own` (then `tolra`), `AI_CONTRACT_SQL_FILES='["supabase/release/146_tolra_provided_ai.release.sql","supabase/release/150_ai_cap_key_off.release.sql"]'`, `AI_CONTRACT_TOLRA_CLEAR_FUNCTION=public.ai_helper_tolra_remove_key`, `AI_CONTRACT_TOLRA_CLEAR_CONFIRMATION='REMOVE SHARED TOLRA KEY'`, `npx vitest run --config tests/reviews/ai-independent/vitest.db.config.ts`. These independent fixtures use minimal Auth stand-ins; the standard150 suite additionally runs on the full151 schema. No provider is called.

The required full unit suite passed6894/6894,0 skipped; `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`, `npm run lint`, `git diff --check` passed. A final check after the fixture/doc edits is recorded in the PR before handover. Unchecked: hosted Auth expiry/MFA lifecycle beyond explicit cases, full repository database/browser suite, production/deployed configuration, real provider consent and financial business sign-off.

Intermediate combined browser run42186212433 atc379a0170054c2be859dff80a4e86a209604454a succeeded; the final SQL guard/test profile must have its own rerun. Normal CI42186212634 web passed but required ci-gate failed because integration was intentionally not run on this draft without ready label; do not call that full CI green. No candidate gate is weakened or label added to imply integration approval.

At08:12 PM reprioritised CI run8 Microsoft diagnosis before the Friday pack: own draft #442 codex/run8-microsoft-diagnosis, original8e49fcb source app unchanged. The original main trace was not uploaded; surviving artifact/logs alone cannot classify listener/app/network failure. A new narrow workflow retains it and all assertions. This does not delay recording the remaining441 security blockers.
