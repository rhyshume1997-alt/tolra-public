# Builder 3: independent public AI contract verification

**Tests and evidence only. No implementation is changed.** New branch `codex/ai-independent-verification` starts from main `68f89ca7b801a10587ff9b51d6c820462847b65a`. Existing #410 tests are not counted as this verification. New tests have ordinary assertions: current defects fail, without `it.fails`, expected-failure conversion or silent skips.

The integrated candidate/migration **150 is not public and was not read, tested, edited or guessed**. This is the contract it must pass when Code supplies the real source and interface. No #359, candidate/go-live/other-agent branch, app implementation, numbered migration, production SQL, real data, provider call or company activation is touched.

## Plain-English result

Main still starts own-key AI at £5, not £10. #410 fixes that default only after its separate SQL proposal is applied; it is not a merged default today. Neither main nor #410 turns the feature switches off when a company key changes. Removing and later adding a key can therefore let AI run again without the required explicit re-enable.

The older public Tolra code starts provided mode at £10, but keeps a separate own-key allowance. The new test exhausts a selected 25p allowance, switches to own-key and re-enables using the allowance status already reports: another 1p request succeeds. That is a bypass of the required single company allowance, even though each individual request still goes through a reservation. No completely unmetered SDK call path was found.

Existing usage/request/audit history, company separation, support refusal and concurrent-request limits pass the executed checks. These passes do not excuse the OFF/default/mode defects. In provided mode, three key-removal checks fail because no public removal interface exists; they do not prove that a removal destroyed history. Migration 150 needs its actual removal interface mapped and then all those tests run.

## Exact public subjects

| Subject | Immutable source |
|---|---|
| Main | `68f89ca7b801a10587ff9b51d6c820462847b65a` |
| #410 | `8bfed64e56d5a7645ebdcb758e8d8c0d0085f71e`, tree `ab73f0395c693ec687b7ea51d496e081f6107b60`; read-only local source has that identical tree |
| Public provided-mode evidence cited by #387 | `9d7725e7e1b59e68a314c4148513b9b7d7aa4e92`; inspected release 146 and server/key-context/owner routes only; no branch updated |
| #387 scope note | `09060dadd660beeb5ff42d39f3ee0a5d94548a64`, `docs/audit/G31-AI-CAP-SPEC.md`, explicitly says own-key still defaults to 500p |
| Migration 150 / integrated candidate | **Unavailable / not executed** |

The five AI baseline SQL files used by the DB fixture are byte-identical between main and public `9d7725e` (Git blob IDs recorded in `evidence/sources.json`). The public 146 SQL and server/context snapshots also match their exact GitHub blob IDs. They were fetched into a separate temporary source folder, not copied into the application or added as a replacement AI implementation.

## Every AI path and its cap

References in the first four rows are main/#410 unless marked otherwise. The default is not a fixed maximum: authorised changes are allowed, but one company's chosen allowance must apply across its paid paths/key modes.

| Path | File path / enforcing code | Main today | #410 with its proposal | Public provided-mode code |
|---|---|---|---|---|
| Round-up | `app/api/ai-helper/roundup/route.ts` → `lib/ai-helper/server.ts` → `ai_helper_reserve`; `supabase/migrations/133_ai_helper_pre_enable.sql` | Own-company cap enforced, **500p default** | Own-company cap enforced, **1000p default** | 146 dispatches to own or Tolra reserve; own default remains 500p, Tolra default 1000p |
| RFQ reading | `app/api/ai-helper/rfq/route.ts` → same helper/reserve; model output is reviewed before `rfq/decision/route.ts` can create a draft | Same 500p default | Same 1000p proposed default | Same split caps as round-up; no model call on cap refusal |
| Assistant, including four text draft kinds | `app/api/ai-helper/assistant/route.ts`, `lib/ai-helper/assistant.ts`, `server.ts` → `ai_helper_reserve_assistant`; `supabase/migrations/134_ai_assistant.sql` | Same company/month ledger, **500p default** | Same ledger, **1000p proposed default** | 146 dispatches assistant reservations too; split mode caps remain |
| Finance check | `app/api/ai/finance-check/route.ts`, `decision/route.ts`, `lib/ai/finance-check/check.ts`, `flag.ts` | Deterministic, **no model/tokens/cost**; OFF switches apply | Unchanged | Not a paid-provider cap bypass; no SDK call |
| Own-key mode | `app/api/ai-helper/key/route.ts`, `lib/ai-helper/server.ts`; `supabase/migrations/122_ai_helper_cap_default.sql:62,76`; `101_ai_helper.sql:248–280` key setter | Status and actual column default **500p**, not compliant with the new 1000p default | `supabase/proposals/ai_ready_for_keys.sql` changes both to 1000p only when applied; it does not replace the key setter | 146 renames the old functions to `_ai_helper_reserve_own_key`, `_ai_helper_reserve_assistant_own_key`, `_ai_helper_status_own_key`; **500p remains** |
| Tolra-provided mode | Public `supabase/release/146_tolra_provided_ai.release.sql`: `ai_helper_tolra_companies`, `_ai_helper_reserve_tolra`, wrapper reserves, `ai_helper_tolra_set_cap`; `app/api/ai-helper/tolra-mode/route.ts`, `app/api/platform/tolra-ai/caps/route.ts`; provided `lib/ai-helper/server.ts` selects the recorded key source | **Not implemented on main**; cannot certify it from main's server | **Not integrated in #410**; a synthetic future `key_source=tolra` reservation is handled as own-key by that main-based server | **1000p per company provided cap enforced**, owner/service setter only, but separate from own-key cap; shared usage does not prevent selecting a higher cap by switching modes |

The sole SDK call remains `lib/ai-helper/anthropic.ts`. The new unit tests check reserve-before-key/provider on all three paid features for both declared key sources. They also check positive source selection, server OFF, six support-refused API operations and deterministic finance/no mutation. A positive Tolra-selection assertion on main/#410 is a **future integration contract failure**, not a claim that a reachable main UI already offers Tolra mode.

## Findings for Code's migration 150

| ID | What must pass | Public finding |
|---|---|---|
| AI-V01 | Existing own-key column default, no-settings status and a new settings row all use 1000p | Main and public-146 own-key fail all three. #410's applied proposal passes them. Do not rewrite historical 122 or call it 1000p today. |
| AI-V02 | Replacing/removing own key turns all company features OFF **in that same transaction**, with explicit later re-enable | `101_ai_helper.sql` only updates key/last-four fields; paid/assistant/finance switches stay on. Main, public-146 own and #410 fail four relevant checks. |
| AI-V03 | Replacing the global Tolra key turns provided AI OFF; removal has a real authorised path; neither silently re-enables it | Public 146 `ai_helper_tolra_configure` accepts `p_enabled=true` with a new key and stays on; NULL coalesces to the old key, so it is not removal. Public platform route has GET/POST and no removal operation. Three removal checks remain failed/unfulfilled until Code exposes/maps the real interface. |
| AI-V04 | One selected company allowance survives funding-mode switches | **Bypass reproduced:** 25p reserved at selected 25p Tolra cap; switch to own-key; existing reported own cap is 500p; a further 1p succeeds. Separate cap storage/defaults must not defeat the agreed company allowance. |
| AI-V05 | Each recorded reservation uses its recorded key source | Provided public server passes all positive source tests. Main/#410 fail the three Tolra positive tests; do not pair their server with provided-mode SQL and infer correct billing/key selection. |
| AI-V06 | Lowering a cap below spent plus held reservations refuses | Legacy own-key setter on main/public146 accepts it; #410 proposal and provided setter refuse correctly. |
| AI-V07 | Key changes preserve spent **and** reserved usage, settled/open request history and every existing audit row | Executed replacement/own-removal checks pass with 7p spent + 11p held, two request states and existing audit rows. New legitimate audit events may append; old rows cannot be edited/deleted. Tolra removal is untestable through the missing public interface, not a preservation pass. |
| AI-V08 | New-company OFF, company separation, support refusal, service-only settlement and simultaneous requests stay within budget | Pass in the focused real-PostgreSQL fixture. Race uses two physical sessions competing for the last 15p with two 10p requests; exactly one reserves. |

For shared Tolra credentials, global OFF is the required immediate boundary; company caps/history must be preserved. A company-owned key change must not turn another enabled company off. The tests distinguish these scopes rather than assuming every key is company-owned.

## Real results (not expected-failure conversions)

| Executed subject | Unit passed / failed / skipped | Database passed / failed / skipped |
|---|---|---|
| Main, own-key database | **22 / 3 / 0** | **16 / 8 / 0** |
| #410 source + its SQL proposal, own-key database | **22 / 3 / 0** | **20 / 4 / 0** |
| Public 146 server/context overlay, own-key database | **25 / 0 / 0** | **16 / 8 / 0** |
| Same public 146, provided-mode database | same 25 unit cases, do not recount | **18 / 6 / 0** (three failures identify the missing removal interface) |
| Unpublished 150 / complete integrated candidate | **NOT RUN** | **NOT RUN** |

Each unit run contains 25 cases; each DB run contains 24. These profiles repeat the same contract against different subjects: do not add them into one product-pass total. Typecheck and lint on the new test code pass. Machine-readable per-case results, original report hashes, exact commands and DB identities/SQL hashes are in `evidence/results.json`, `evidence/*-receipt.json`, and `evidence/sources.json`.

Real PostgreSQL **17.6**, nonce-named empty `ai_verify_*` databases on a loopback-only disposable cluster. The runner creates and later drops only its own named test DB. It loads exact AI migrations 101/103/122/133/134 and the exact finance-switch section of 106. Optional reviewed SQL overlays are applied only there. `bootstrap.sql` supplies explicit minimal auth/session/MFA/audit infrastructure and empty release-145 prerequisites; it does **not** replace any AI implementation or policy. This is focused AI SQL/RLS/atomicity testing, not full Supabase authentication, full migration replay, hosted acceptance or production verification.

## Exact commands / use on the real 150 when public

From this verification branch, with existing dependencies installed:

```sh
node_modules/.bin/vitest run -c tests/reviews/ai-independent/vitest.unit.config.ts
AI_CONTRACT_ADMIN_URL=postgresql://ai_test@127.0.0.1:55439/postgres node_modules/.bin/vitest run -c tests/reviews/ai-independent/vitest.db.config.ts
npm run typecheck
node_modules/.bin/eslint tests/reviews/ai-independent --ext .ts
```

The first two commands are correctly **red today**. The full exact commands used for every published profile are preserved in `evidence/results.json`, including environment prefixes and JSON reporter arguments.

Read-only source snapshots outside this checkout were used for #410/public146. For the #410 profile: `AI_CONTRACT_SOURCE_ROOT=/workspace/work/ai-ready-for-keys`, `AI_CONTRACT_SQL_FILES='["/workspace/work/ai-ready-for-keys/supabase/proposals/ai_ready_for_keys.sql"]'`. That local tree is identical to the reviewed public head. For public146: `AI_CONTRACT_SQL_FILES='["/workspace/work/ai-public-evidence/146.sql"]'` and `AI_CONTRACT_MODE=own` or `tolra`; the unit profile selects pinned `server.ts` and key context via `AI_CONTRACT_SERVER_FILE` / `AI_CONTRACT_CONTEXT_FILE`. No candidate branch was checked out or written.

When 150 is public, Code must pin its real commit/tree, use the real source snapshot through `AI_CONTRACT_SOURCE_ROOT`, and supply the reviewed prerequisite/150 SQL files through the JSON array `AI_CONTRACT_SQL_FILES` for this empty fixture. Run both `AI_CONTRACT_MODE=own` and `tolra` plus the unit suite. If its prerequisite/schema interfaces differ, adapt only the fixture/interface adapter to the **real** published code and keep the substantive assertions. Do not recreate 150, stub a cap or fake an OFF result.

`AI_CONTRACT_TOLRA_CLEAR_FUNCTION` can map a real `public.function_name(uuid_owner)` removal interface. No such public interface was assumed or invented. If 150 exposes a different signature/route, map that real interface in the test adapter once visible. The three explicit absence failures must become executed passes, not skips. Complete hosted/auth/browser checks remain separate.

## Files / handover

All additions are under `tests/reviews/ai-independent/`: two Vitest configs, `cap.unit.test.ts`, `cap.db.test.ts`, DB fixture/adapter `database.ts`, test-only `bootstrap.sql` and `server-only.ts`, this report, and evidence. No pre-existing file changes.

**Done:** public-source review, path/cap inventory, new ordinary regression contracts, executed subject matrix, reproduced bypass/default/OFF gaps, history/isolation/support/race evidence, and this committed handover. **In progress / next owner:** Code integrates the real 150, supplies its immutable public ref and real removal interface, and reruns the contracts. **Not started/unavailable:** migration-150 verification, hosted/provider acceptance, production SQL/configuration, deployment or merge. No failed contract is marked DONE or READY FOR KEYS.
