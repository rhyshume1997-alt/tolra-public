# IQ: is the test installation identified and ready?

Company: ____  Intended use: ____  Test environment URL: ____  Commit/release: ____

Run on a disposable test installation, never on production. The pack does not install or migrate a database. Record migration status read-only and have the environment owner prepare any missing setup separately.

| Step | Action | Expected result | Pass / Fail / Not run | Actual result / evidence | Tester / date |
| --- | --- | --- | --- | --- | --- |
| IQ-001 | Run `git rev-parse HEAD` and `git status --short`. Record release and any differences. | Exact tested code is identified; differences are understood and approved. | NOT TESTED for final installation | Frozen clean code head d73bb240a23b38a7080c0933e4f5b62ddd529f5f; CURRENT-RESULTS.md. Historical local identification only; actual final review head is in PR #280. This does not identify a deployed installation. | Codex, 2026-11-04 UTC |
| IQ-002 | Run `node --version` and `npm --version`; compare Node with the repository CI configuration. | Supported versions recorded; differences approved before testing. | NOT TESTED | No exact-head runtime/manual evidence | NOT TESTED |
| IQ-003 | Run `npm ci` from repository root. | Locked dependencies install successfully. Save the exit code and log. | NOT TESTED | No exact-head runtime/manual evidence | NOT TESTED |
| IQ-004 | Owner checks test URL, database identity, migration inventory and backup/restore arrangements. Do not print secrets. | Disposable environment is confirmed; no real customer data; required schema is present. | NOT TESTED | No exact-head runtime/manual evidence | NOT TESTED |
| IQ-005 | Owner provides fake companies A/B, admin, office, workshop and read-only support identities. Keep passwords outside evidence. | Access and company boundaries can be tested independently. | NOT TESTED | No exact-head runtime/manual evidence | NOT TESTED |
| IQ-006 | Run `node tests/validation/check-pack.mjs`, `npm run typecheck` and `npm run lint`. | Pack links, TypeScript and lint pass; existing warnings are recorded and assessed. | NOT TESTED | No exact-head runtime/manual evidence | NOT TESTED |

Numbered rehearsal sources: IQ-001: G00.1; IQ-002: G00.2; IQ-003: G00.3; IQ-004: G00.4; IQ-005: G00.5; IQ-006: G00.6. See TRACEABILITY.md. IQ-004 requires verified 138, required JNR releases 140/141, verified 144, then 145 and 146; schema preparation is outside this pack. No SQL is applied by its commands.
