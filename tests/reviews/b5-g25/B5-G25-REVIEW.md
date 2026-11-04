# G25 customer payment claims and financial integrity review

Reviewed public delivery-note candidate `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. This is a pinned read-only checkout of #359; Claude Code’s branch and its owned test files were not edited. New tests have unique `b5-` names. No ISO packs started. No production URL/key, production SQL/wipe/import/counter action, main merge, deployment, live AI or automated email was used. John was not contacted.

Evidence directories keep original logs (including initial failures), UTC times, exit codes, environment/source commit and SHA-256 SQL-input manifests. Counter SQL additionally records each actual statement hash, exit/time/output and a nonce/container identity receipt. Scope limits below are part of each verdict; no skipped/blocked runtime check is a pass.

G25: independent source and adversarial unit review done; no financial write found on the reviewed claim/evidence paths. Nine new tests passed, plus existing inbound/chase checks in the 280-test baseline. Actual end-to-end database invariance remains **NOT EXECUTED** because full Supabase startup is policy-blocked. No payment, customer email or live claim was created.

[lib/integrations/microsoft/inbox.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/integrations/microsoft/inbox.ts) records intake through `mailbox_record_inbound`. The new tests use seven adversarial texts (immediate-paid demand, INV-1/INV-10 ambiguity, future/question wording, SQL-like instruction, refund demand and other-company reference), a spoofed synthetic sender and a service double with **no financial table write methods**. Only the evidence RPC may be called, bound to the intended company. All three financial-control arguments are individually forbidden. These are evidence-storage assertions, not proof the spoofed sender is authentic or that the wording is a verified payment.

Both `confirmed` and `not_received` resolution paths call only `resolve_payment_claim` in the new client test. In [supabase/migrations/138_chase_steps.sql](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/migrations/138_chase_steps.sql), `mark_payment_claimed` writes claim evidence fields and `resolve_payment_claim` clears those fields under company/role checks, then audits the action. A confirmed claim is not `record_invoice_payment`: finance records a bank-verified receipt separately. The actual SQL functions were source-reviewed only, not replayed against a full app schema here.

Existing `chase-inbound-never-paid` tests also inspect the delegated intake SQL for forbidden financial mutation and exercise mocked polling. The original upstream files were not changed. The combined new adversarial log contains two G27 failures; it must not be called an all-pass run even though this file’s nine checks passed. Original log, source SHA, UTC time, SQL manifest, environment and exit status are retained.

Next: on an externally attested disposable restore, compare invoice total/status/paid/credited/refunded/balance/payment rows before and after manual/email claim, duplicate replay, spoofed/ambiguous references and both resolution outcomes; require only claim/evidence/audit changes. Test a wrong-company claim and role refusals. Keep email send disabled and no production connection. There is no authority to mark an invoice paid from a claim or to run a production import.

## Exact committed-code rerun

Executed checkout `1fb3eddda38c8716cf7029b48977ea795dd1b9b8`; UTC 2026-11-04T21:57:40.504882+00:00; exit 0; duration 2.349 seconds. Full environment, SQL manifest/log hashes and command file hashes are in `evidence/2026-11-04T21-57-40.504882+00-00-committed-payment-claims-4e12da/run.json`; original log bytes retained. This supersedes contextual checkout ambiguity for earlier uncommitted test overlays. Later commits only attach review/evidence.

Nine scoped tests passed with zero skips; this does not establish live or full-database behaviour.
