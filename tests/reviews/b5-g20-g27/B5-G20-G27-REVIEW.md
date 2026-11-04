# G20 / G27 disabled launch and AI security review

Reviewed public delivery-note candidate `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. This is a pinned read-only checkout of #359; Claude Code’s branch and its owned test files were not edited. New tests have unique `b5-` names. No ISO packs started. No production URL/key, production SQL/wipe/import/counter action, main merge, deployment, live AI or automated email was used. John was not contacted.

Evidence directories keep original logs (including initial failures), UTC times, exit codes, environment/source commit and SHA-256 SQL-input manifests. Counter SQL additionally records each actual statement hash, exit/time/output and a nonce/container identity receipt. Scope limits below are part of each verdict; no skipped/blocked runtime check is a pass.

## Status and finding

- G20: review/mocked negative checks done; actual launch-disabled configuration/connection-state proof **NOT VERIFIED**. No provider was called or live integration enabled.
- G27: one confirmed brief-to-code cap mismatch in two places; **fixes pending**, two strict assertions retained failing. Other new security checks passed; full reservation/concurrency/tenant database proof remains blocked.

The brief requires a £5 per-company cap. [lib/ai-helper/tolra-caps.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/ai-helper/tolra-caps.ts) defines the Tolra-provided default as 1000p (£10); [supabase/release/146_tolra_provided_ai.release.sql](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/release/146_tolra_provided_ai.release.sql) also creates the provided-mode company cap at 1000p. Own-key migration 122 defaults to 500p (£5). These modes must not be conflated. Owner must align provided-mode defaults with the brief or obtain Rhys’s explicit scope decision; no code or migration was changed here. The tests deliberately continue expecting 500p and fail; do not update the expected value to hide the mismatch. No claim that an actual company has spent above £5 was made.

## Independent checks/evidence

Baseline: 280 passing tests across 14 files, including existing AI route, cap, accounting-route/token-isolation cases. New combined run: 28 passed, two cap assertions failed across three files. Within this new security file: ten passed, two failed. New passing cases include six malformed/off flag values, both assistant server switches required, company master state off, Sage/QBO unavailable for an explicit empty environment and company-filtered assistant context without amounts/free text/customer identity. Server-only import setup failure is preserved; the Node test shim changes no production guard or security expectation.

[lib/ai-helper/flag.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/ai-helper/flag.ts) is off unless exact feature flags enable it; [lib/ai-helper/master-switch.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/ai-helper/master-switch.ts) maps company feature state. [lib/ai-helper/assistant.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/ai-helper/assistant.ts) uses allow-listed company context and masks customer names. These source/unit results do not establish deployment flag values, actual RLS, key storage or concurrent reservation outcomes. Existing routes/cap checks were not weakened, and no model/network request used a key.

## G20 launch proof needed

Review [lib/accounting/connections.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/accounting/connections.ts), cloud adapter readiness, Xero configuration/token readiness and AI flags. Missing credentials can make adapters unavailable, but that alone does not prove a connected tenant cannot send. Require the final deployment’s approved disabled state for Xero/Sage/QuickBooks/AI, with relevant per-company connections/automatic schedules/export entry points independently checked on a nonce-verified disposable restore. Do not print tokens or use production keys to obtain this proof. Actual flags and connection rows were not supplied/read.

## G27 remaining tests

Run per-company reservations/settlement under concurrency at the approved 500p boundary, cross-company key/request/cap access refusal, owner-vs-support permissions, disabled defaults and prompt-injection/action refusal on the final combined SHA. Enabling live AI, changing a production cap or reinstalling 146 after rollback is outside this work. Full Supabase startup failed on the policy-blocked registry; that failed original log is retained. No ISO work started.

## Exact committed-code rerun

Executed checkout `241f434f3c4375ef53e454c3303123249efc84b1`; UTC 2026-11-04T21:57:40.685546+00:00; exit 1; duration 2.161 seconds. Full environment, SQL manifest/log hashes and command file hashes are in `evidence/2026-11-04T21-57-40.685546+00-00-committed-ai-security-6f6299/run.json`; original log bytes retained. This supersedes contextual checkout ambiguity for earlier uncommitted test overlays. Later commits only attach review/evidence.

Twelve tests: ten passed, two required-500p assertions failed. No expected value changed.
