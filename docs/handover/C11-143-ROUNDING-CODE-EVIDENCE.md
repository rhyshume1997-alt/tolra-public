# C11 — evidence for migration 143 and rounding boundaries

Builder 6 / L13 / 4 November 2026. **The reviewed 143 SQL does not replace the existing financial rounding functions or the costing rounding algorithm. It can enable different costing inputs, so “143 cannot affect any rounded result” is not a justified claim.** This report proves the narrower code boundary and lists what still needs runtime evidence. No code/SQL was changed or executed by this job.

## Exact sources

- 143 implementation: `claude/costing-in-app` at `8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d`. Migration and its release wrapper were read; the wrapper carries the same reviewed DDL inside its execution guards/transaction.
- Combined costing code: `codex/costing-join` at `a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2`. This is held costing work, not an assumed included go-live feature.
- Go-live release plan: `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. [supabase/release-plan.json:40](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release-plan.json#L40) explicitly defers 143; it is absent from that candidate's migration/release tree. Do not cite an absent 143 file on the candidate as if it were deployed.

## What the SQL actually touches

| Evidence | Boundary shown |
| --- | --- |
| [supabase/migrations/143_costing_rates.sql:47](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L47) | New costing-material table: whole integer `price_pence`; percentage precision is explicitly NUMERIC(5,2). |
| [supabase/migrations/143_costing_rates.sql:60](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L60) | New costing-machine table: integer hourly/labour pence; no invoice/quote line schema change. |
| [supabase/migrations/143_costing_rates.sql:72](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L72) | New per-company defaults: integer labour/programming pence plus numeric overhead/margin percentages. |
| [supabase/migrations/143_costing_rates.sql:85](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L85) | The defined trigger stamps updated_at/updated_by and refuses a company move. It has no money calculation or rounding branch. |
| [supabase/migrations/143_costing_rates.sql:108](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L108) | Dynamic ALTER/GRANT/policy/trigger statements iterate exactly the three costing tables; they do not install triggers on invoice/quote/credit/payment tables. Existing audit/support/MFA helpers are referenced, not redefined. |
| [supabase/migrations/143_costing_rates.sql:94](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/supabase/migrations/143_costing_rates.sql#L94) | Stamping mutates metadata, not monetary values. Existing helper bodies are not replaced by this migration. |

The DDL's monetary INTEGER storage does not modify `lib/money.ts` or PostgreSQL's built-in `round(numeric, integer)`. Its percentage NUMERIC scales **do** constrain stored rate precision; extra-decimal input can be coerced at storage or refused by app validation. That may change an input/result relative to an unbounded input, even though the engine rounding routine is unchanged. Do not turn “no shared rounding function changed” into a promise of identical prices for different rates.

## Ordinary invoice/quote/credit money path

[lib/money.ts:32](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/money.ts#L32) implements exact decimal-to-pence rounding, with the half-away-from-zero increment at [lib/money.ts:37](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/money.ts#L37). `toPence` and line multiplication call that helper: [lib/money.ts:42](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/money.ts#L42) and [lib/money.ts:49](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/money.ts#L49).

The Git blob for `lib/money.ts` is **62bfe43fbbea5fb55af7dd0616c36e27c6e2b319** on BOTH the pinned 143 implementation branch and candidate 9c3f5c6. That is byte-identity evidence for this shared module, not an executed app-versus-SQL parity result. 143 neither ships a replacement for that module nor modifies existing monetary-table functions/triggers. Other separately integrated app changes must be reviewed independently.

## Deliberately different costing path

[lib/costing/rates-store.ts:7](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/costing/rates-store.ts#L7) documents pounds/pence and percent/fraction conversions; [lib/costing/rates-store.ts:145](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/costing/rates-store.ts#L145) reads the new costing tables. Without 143 the helper reports not-applied/off: [lib/costing/rates-store.ts:13](https://github.com/rhyshume1997-alt/tolra-public/blob/8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d/lib/costing/rates-store.ts#L13). Adding/configuring 143 can therefore make rates available; changing rates changes calculation inputs.

The combined engine has its own Python-compatible binary64 tie-to-even routine at [lib/costing/engine.ts:18](https://github.com/rhyshume1997-alt/tolra-public/blob/a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2/lib/costing/engine.ts#L18), inspects the original float rather than a decimal-pence conversion, and serializes rounded costing outputs: [lib/costing/engine.ts:67](https://github.com/rhyshume1997-alt/tolra-public/blob/a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2/lib/costing/engine.ts#L67). Detailed costing starts at [lib/costing/engine.ts:71](https://github.com/rhyshume1997-alt/tolra-public/blob/a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2/lib/costing/engine.ts#L71). This protected costing behaviour must not be replaced by the shared half-away financial helper in the name of consistency.

The settings bridge itself rounds entered pounds to pence: [lib/costing/atomic-settings.ts:11](https://github.com/rhyshume1997-alt/tolra-public/blob/a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2/lib/costing/atomic-settings.ts#L11). That is an existing app input boundary, distinct from the engine's final tie-to-even output rule. The SQL does not rewrite either routine. A costing price selected into a quote becomes an input to the ordinary document calculation, so the *value* reaching shared invoice/quote rounding can change indirectly.

## Proof limits / reviewer checks

- Compare full reviewed 143 SQL objects/dependencies and existing money-function definitions before/after on the separately authorised disposable backend; prove no unrelated catalog/body/trigger change. Source inspection alone is not that database experiment.
- Run ordinary app/SQL penny-parity/line/VAT/credit tests and the combined engine's protected golden fixtures on the exact integrated branch with engine present. [tests/unit/costing-golden.test.ts:52](https://github.com/rhyshume1997-alt/tolra-public/blob/a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2/tests/unit/costing-golden.test.ts#L52) shows why collection or an absent-engine skip is not a 60-case engine pass. This job did not run those suites or change their 60 golden answers.
- With fixed identical input rates/parts/quantities, compare raw/intermediate and rounded costing results; test missing-143/off and configured-143 paths separately. Test integer-pence and percentage precision boundaries and the quote-line handoff. Do not compare differing saved rates and label the difference a changed rounding rule.
- Keep 143 excluded from this six-release cutover unless an explicit separately reviewed scope/integration decision changes that plan. No new scope or assertion of global mathematical non-interference is made here.

## Handover

Atomic claims/L13. Cited immutable source lines, SQL object inventory, unchanged money blob and separate conversion/engine paths checked. Documentation only; actual 143 application, catalog comparison, SQL parity and engine/runtime validation remain open for the original owner/reviewer. No new tests for this read-only report, no original costing edits, main merge, production SQL, Ready label or deployment.
