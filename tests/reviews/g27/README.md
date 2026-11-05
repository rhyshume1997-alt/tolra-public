# G27 — AI concurrency and key-logging review

Run `npx vitest run -c tests/reviews/g27/vitest.config.ts` from the repository root. Docker and the pinned PostgreSQL image must already be available. The runner creates its own nonce-labelled, network-isolated, disposable container and accepts no DB URL. It verifies ID, label, image, no published ports and database identity before SQL; SQL hash, commit/environment/time/exit code and original log hashes are recorded under `/tmp/tolra-g27-*`. Only synthetic data, fake ciphertext and a clearly synthetic key marker are used. No provider is contacted.

Actual main function bodies: 121 membership, 036 access, 019/033 MFA, 101 AI tables/caller/audit, 133 reservation/settlement, 134 assistant. The unchanged complete public release 146 is loaded from pinned commit `31f965e7f0cbb2d9caf336b0a2067411bec8fb45` with `git show`. Source/branches/#359 are never modified. Base supporting tables/JWT functions are minimal synthetic prerequisites; 145's unrelated setup/readiness dependency is represented by an empty table and a readiness function returning false. This is narrow SQL execution, not a complete baseline/upgrade, browser, Auth-service or deployment proof.

The tests use concurrent separate PostgreSQL connections, not mocked budget arithmetic. They cover 30 mixed-feature reservations against one monthly ledger, a second company's separate budget, concurrent settlement/replay, stale-reservation charging, disabled defaults and admin switch approval. A separately configured 500p provided-mode fixture tests that arithmetic independently of its default. Synthetic configuration does not fix or approve any live company.

Five main server `runAiHelper` failure paths receive a synthetic key marker inside errors: reserve, key read, provider, validation and settlement. Captured console error/warn/log calls and returned outcomes must omit it. No actual secret is available. SQL reservation replies, request records and audit metadata must omit ciphertext, and an authenticated caller must not read `ai_helper_secrets`. These are scoped checks, not proof of every hosting/provider log or the final candidate server route.

## G27-01 — default provided cap violates the £5 requirement

#375 already found the 1000p default in source. This suite adds runtime concurrency evidence: when the provided mode is explicitly enabled in the synthetic fixture **without changing its default cap**, twenty 50p reservations succeed instead of ten. The strict expectation remains 500p and fails. No expected value was increased; no security guard, application code or migration was changed. Own-key/default 500p and explicitly configured provided-mode 500p arithmetic are separate passing cases. Release readiness is **FAILED / fix pending owner**; this suite is not an all-pass gate.

The cap is configurable in current software; these results do not prove an immutable £5 maximum against an authorised cap change. Approval of launch settings, final combined SHA, production flags, actual provider billing and live configuration remain unverified. Do not enable AI to obtain evidence. Do not re-apply 146 after its rollback.

Acceptance record: requirement G27; expected £5 monthly limit and no secret disclosure; actual ____ **NOT EXECUTED** for final release acceptance; evidence reference ____; tester ____; date ____; approval ____.
