# D — Finish existing Xero read-back safety

Main base: 68f89ca7b801a10587ff9b51d6c820462847b65a. No redesign, migration, live call, credentials or activation. Status: **DONE (coded)** for this fix; review/merge/deployment unproven. Xero remains **CONFIGURATION REQUIRED** and transfers OFF for an unconnected/unconfigured company. This PR does not create a connection, map an account, queue a transfer or enable a cron. Once an admin connects/maps an existing company, the existing issue/sweep path can send: there is no separate new universal OFF switch in this change. Do not connect a live tenant before Rhys authorises it.

| Existing path | Evidence run with mocks | Outcome / limit |
| --- | --- | --- |
| Connect/OAuth | lib/integrations/xero/oauth.ts, signed-state.ts, tokens.ts; integrations-crypto-oauth/connect-safety/connect-107 suites | Code flow, state, tenant selection and token lease checks pass; real redirect/consent/refresh unproven |
| Admin controls/company | app/api/integrations/xero; xero-pr2-access and batch-routes suites | Auth, support refusal, own-company route checks pass; database RLS not re-executed here |
| Mapping/contact match | xero/mapper.ts, contacts.ts, mappings.ts; mapper, mappings-send-log and integrations-engine suites | Mapping gates, contact ambiguity and no guessing tested |
| Invoice/credit transfer | xero/client.ts, engine.ts; integrations-engine and mapper suites | Fake fetch/provider only; totals/idempotency and document shape tested; no live transfer |
| Retry/duplicates | engine.ts, tokens.ts; engine and batch suites | Retry lease, stable idempotency, read-back before retry, uncertain outcomes/429/reconnect paths tested |
| Reconciliation/failure report | client readBack → engine settle/needs_check → send log; new xero-readback-safety suite | Fixed defects below; never substitute missing totals or silently pick the first duplicate |
| Default-off | migration084 gate/queue, server.ts xeroReady, not-configured paths; connect/access/engine suites | No transfer without configuration and connected/mapped company. Production state not inspected. Existing connected companies need explicit operator check before launch. |

Fixes in **lib/integrations/xero/client.ts** only:
- Multiple matching sales records now throw an unknown-outcome error, so the engine holds the send for checking.
- Missing or invalid numeric net/VAT/gross totals no longer become zero.
- Purchase credits cannot stand in for sales credits. Incomplete document lists, matching rows without identity/type are unknown, not proof the document is absent.

Tests first: original 13 adversarial cases gave **2 passed / 11 failed / 0 skipped**, exit 1. Original before.log is retained. After fix plus three incomplete-response cases: **233 passed / 0 failed / 0 skipped**, 14 suites (16 new tests). The remaining 217 are existing Xero/OAuth/control tests, not the unrelated B run with the same total. Tests use synthetic tokens/records and fake fetch; no real Xero calls. Commands/output: tests/reviews/xero-finish/evidence. TypeScript and targeted lint results are recorded separately.

Still unproven: real tenant consent/configuration, database permission execution, final-sha browser behaviour, live API response shapes and accountant/business acceptance. Rhys approves activation; admins/accountant approve tenant and account/VAT mappings. No one has approved those here. No John message, private source or #359/go-live edits.
