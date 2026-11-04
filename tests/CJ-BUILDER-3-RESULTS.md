# CJ browser run, builder 3, 4 November 2026

Source: draft PR #281, code head `8c5161c20745fb8be2e4239ecf9076f7507d437f`.
Specs: `tests/e2e/acceptance/n1-paid-breaks.spec.ts`, `tests/e2e/acceptance/n5-blank-setup.spec.ts`, `tests/e2e/acceptance/n6-email-editor.spec.ts`.
Requirements: `tests/MANUAL-CHECKS-GO-LIVE.md` G04 (N1), G08 (N5), G10 (N6).

- PASS, collection only: `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance --list`. Exit 0; 3 tests in 3 files.
- FAIL, setup blocked: `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance`. Exit 1 in global setup: `IsolationError: Isolated test backend required: TEST_SUPABASE_URL is not set`. No browser assertions executed; N1/N5/N6 runtime remains NOT TESTED.
- Backend diagnostic: `env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock info --format '{{.ServerVersion}}'`. Exit 1, permission denied for local Docker socket. User UID 1000; dockerd running (PID 253). This is the current environment blocker; the older ENOSPC report is historical.

Execution used a separate workspace reconstructed from main 68f89ca plus the public #284 comparison; shared preinstalled dependencies were used. It was not a clean locked install or exact-head CI run. The three specs and setup files match the existing stack. Collection and refusal evidence do not prove browser behaviour.

Claude Code: recover local Docker access, prepare the independently verified fake-only backend with reviewed 138/140/141/144/145/146, then run the runtime command above at the final integrated SHA. Keep remaining G04/G08/G10 manual conditions open: these three focused specs do not replace every row of the manual checklist. No hosted backend, production SQL, migration application, merge or deployment was used here.
