# G31 verification

Run `npx vitest run -c tests/reviews/g31/vitest.config.ts`. Main branch is unchanged; source SQL is read from public `9d7725e7e1b59e68a314c4148513b9b7d7aa4e92` with `git show` (fetch that public commit if absent). Complete numbered migrations then 145/146/147 run unchanged. Minimal Auth/Storage schema/JWT prerequisites are test-only; no running Auth/Storage/PostgREST or final server-route proof is claimed.

The runner creates its own pinned-image, random nonce-labelled, network-isolated PostgreSQL container with no published ports, verifies identity before SQL, accepts no DB URL and removes only its own container. All records and ciphertext are synthetic. Per-statement commit/environment/hash/time/exit/original logs are retained under `/tmp/tolra-g31-*`. No provider or real key is used.

Tests cover off/default state, actual setter/grants, non-owner refusals, two independent budgets under concurrent reservations, raising a cap, refusing a reduction below use, and an app-level cap result stopping before key/provider access. The spec is docs/audit/G31-AI-CAP-SPEC.md; #381's older 500p expectation is superseded by Rhys's new decision, not reclassified as a pass. Legacy own-key default and final route/MFA/live settings are explicitly unproven here.
