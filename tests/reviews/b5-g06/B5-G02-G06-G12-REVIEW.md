# G02 / G06 / G12 independent review and narrow disposable rehearsal

Reviewed public delivery-note candidate `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. This is a pinned read-only checkout of #359; Claude Code’s branch and its owned test files were not edited. New tests have unique `b5-` names. No ISO packs started. No production URL/key, production SQL/wipe/import/counter action, main merge, deployment, live AI or automated email was used. John was not contacted.

Evidence directories keep original logs (including initial failures), UTC times, exit codes, environment/source commit and SHA-256 SQL-input manifests. Counter SQL additionally records each actual statement hash, exit/time/output and a nonce/container identity receipt. Scope limits below are part of each verdict; no skipped/blocked runtime check is a pass.

## Verdict

- G02: review done, two assurance gaps; fixture restore compared every fixture object in **1.6622 seconds**; full Supabase/Storage/Auth/roles recovery BLOCKED.
- G06: review done, **two conditional SQL-role findings**, fixes pending owner review. Twelve narrow fixture checks: ten passed, two deliberately failed; overall exit 1 retained.
- G12: private historical kit reviewed; current combined-kit/restored-JNR rehearsal **NOT EXECUTED**. Synthetic Marpet counter stayed unchanged; that is not real Marpet wipe evidence.

## G06 findings — do not promote the fixture to a browser exploit

1. `delivery_notes_numbering_guard` trusts the session setting `quoteflow.delivery_note_new = on`. A caller acting as `authenticated` with SQL execution could set it and insert a typed number. The real 147 trigger, unchanged, accepted the insert in the fixture. Expected refusal and unchanged state were **not** obtained.
2. The earlier `quoteflow.data_import = organization_id` branch likewise bypassed numbering controls for a same-tenant SQL caller. Expected refusal and unchanged state were **not** obtained.

Both are conditional on SQL/custom-setting ability. No browser/PostgREST route to set either value was proved. The narrow fixture does not install full RLS, the other delivery constraints or audit hash-chain triggers. Claude Code must review the trust boundary and demonstrate the real browser/API and role boundary on the final candidate; use a non-forgeable internal authority if untrusted roles must be prevented from setting these flags. Do not weaken the assertions to accept the bypasses. Sources: [supabase/release/147_job_delivery_note.release.sql](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/release/147_job_delivery_note.release.sql), [supabase/cutover/set_dln_next_number.sql](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/cutover/set_dln_next_number.sql), [supabase/cutover/undo_dln_next_number.sql](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/supabase/cutover/undo_dln_next_number.sql).

Real day-of/undo script tests in PostgreSQL: invalid input/repeat refusal leaves state unchanged; hold lifted by setter and restored by permitted undo; two competing setters give exactly one winner; ordinary typed manual number refused; twelve concurrent manual inserts get twelve distinct numbers; undo after consumption refused unchanged; synthetic other-tenant counter unchanged. The number allocator in this fixture is a small UPDATE model, **not** a proof of the full 078 allocator or complete release 147 install/replay path.

## Identity and restore evidence

The harness accepts no database URL. It creates a random-name container with a nonce label, pinned PostgreSQL image digest, `network=none` and no published ports. It verifies container ID/image/label/network, reads an initially empty public schema, then creates a private nonce marker. Before every later SQL statement it verifies both container identity and the marker. Restore uses a newly created database in that same owned container and verifies its name/empty schema first. Cleanup removes only the identified owned container/volume.

The synthetic pg_dump/restore compared all five fixture tables (including audit fixture rows), function definitions, indexes, constraints and sequence values. It did **not** exercise Tolra’s encrypted backup archive, real audit-chain protection, roles, Auth login, storage bytes/API or the JNR/Marpet production data. Duration is a fixture observation, not an accepted RTO/RPO. Original restore setup failure (`public` schema already exists) and a transient readiness failure remain recorded; fixes changed only harness setup/readiness, not adversarial expectations.

## G02 assurance gaps and blockers

1. [scripts/restore-backup.sh](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/scripts/restore-backup.sh) accepts a non-protected target with no public tables; that is not independent disposable identity attestation. It must be wrapped by the nonce/container barrier for this overnight authority. It was not pointed at any existing database.
2. Full recovery acceptance needs mandatory content/schema/object/roles/files comparison, not counts alone. Archive sidecar verification is conditional and fingerprints are optional unless required; review old/missing-manifest refusal and invoke the reviewed strict mode. No existing test was relaxed. Synthetic backup-stub refusal suite succeeded after the original sandbox socket failure was retained.

Full Supabase startup failed because `public.ecr.aws` was denied by environment network policy. No alternate destination/policy bypass was attempted. Original failed startup log is included; no app SQL was applied there.

## G12 review boundary

Read private historical kit at `ee875c6f7e18221cbfdea32828fd69f634dd8f3d`, `docs/handover/golive-runbooks/28-wipe-jnr.sql` blob `6016c3e191f513f30e9266c6fd97f261b790f315` and associated check/runbook, without executing or copying private source publicly. Its identity/KEEP/WIPE/trigger and other-company fingerprint assertions are source claims, not current results. The marker alone cannot establish an independently created restore. Public #250 already carries NOT SAFE for the unproved combined kit.

Still required: approved exact combined wipe/archival kit and its SQL hashes; an independently identified isolated restore of the approved source; before/after JNR archive/KEEP/WIPE and **all** other-tenant row/file/auth/counter/trigger/audit comparisons; dry and commit/second-run refusal/rollback tests. No restore archive or final combined-kit evidence was supplied here. Do not reuse this tiny counter fixture as JNR wipe approval.

## Exact committed-code rerun

Executed checkout `14c56ebbe68d13b65cdda9f861ee877d3db1806e`; UTC 2026-11-04T21:57:39.140516+00:00; exit 1; duration 14.836 seconds. Full environment, SQL manifest/log hashes and command file hashes are in `evidence/2026-11-04T21-57-39.140516+00-00-committed-counter-review-52a663/run.json`; original log bytes retained. This supersedes contextual checkout ambiguity for earlier uncommitted test overlays. Later commits only attach review/evidence.

Latest narrow fixture restore: 1.6836 seconds, five fixture tables plus definitions/indexes/constraints/sequences compared. Ten checks passed, two guard-bypass checks failed; exit 1 is intentional evidence, not acceptance.
