# Own-key 500p: different funding path

Decision for this queue: **no default migration**. The offered exception applies: this setting controls a company's own provider account, not the platform-held Tolra account. Keep the separate own-key budget; do not overwrite any existing company-chosen cap. Tolra-provided AI has its own per-company settable **1000p** default. Neither route is authorised ON in production by this decision.

| Evidence | Meaning |
| --- | --- |
| Main 68f89ca: supabase/migrations/122_ai_helper_cap_default.sql, monthly_cap_pence DEFAULT 500 and status fallback 500 | Legacy own-key allowance; independently settable through ai_helper_save_settings. 133/134 keep feature switches off by default; lib/ai-helper/flag.ts requires explicit server flags. |
| Main lib/ai-helper/server.ts | Reads only ai_helper_secrets for the caller's organization, decrypts with that company context, passes that key as the provider credential. No platform-key read exists in this main path. |
| Public 9d7725e: supabase/release/146_tolra_provided_ai.release.sql lines 31, 37–41, 122–150 | Separate provided-mode table defaults to 1000. Reserve chooses the company-enabled mode; old functions are retained as own-key functions. Request key_source records own/tolra; status exposes separate monthly_cap_pence and tolra_cap_pence. |
| Same public commit lib/ai-helper/server.ts, key_source branch | Only key_source=tolra calls service RPC ai_helper_tolra_key. Own requests read that company's ai_helper_secrets. Failure returns an error, not a different funding source. |
| Same release146 ai_helper_tolra_key | Only reserved, same-company, tolra-source requests can retrieve the platform-held key. Own-source requests refuse. |

**4 passed, 0 failed, 0 skipped** using the actual public 9d7725e server fixture with mocked RPC/decryption/provider: own credential selection, no fallback on missing key, separate provided credential selection, cap-before-both-paths. The fixture has one relative import relocation only; no private source, real key, live request or SQL. Tests: `npx vitest run --config tests/reviews/own-key/vitest.config.ts`; output in evidence/focused.log.

This proves code selects separate credential stores and does not obtain Tolra's platform-held key for an own request. It does not prove the external billing owner of a manually supplied credential: company-admin/key ownership must be checked before enablement. A deliberately misconfigured/copied key is not detectable from a budget number. No real credentials were inspected. Database mode/RLS enforcement is source evidence here, not a newly run database test; #387 retains its own separate 146 disposable evidence.

This is not a claim that all modes now default to 1000p. If Rhys later explicitly requires the same number for customer-funded keys as well, that is a separate policy change, not a Tolra spending-cap defect. No new migration number, funding switch, activation or company-row update is introduced here.
