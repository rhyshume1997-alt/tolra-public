# IQ: is the test installation identified and ready?

Company: ____  Intended use: ____  Test environment URL: ____  Commit/release: ____

Run on a disposable test installation, never on production. The pack does not install or migrate a database. Record migration status read-only and have the environment owner prepare any missing setup separately.

| Step | Action | Expected result | Pass / Fail / Not run | Actual result / evidence | Tester / date |
| --- | --- | --- | --- | --- | --- |
| IQ-001 | Run `git rev-parse HEAD` and `git status --short`. Record release and any differences. | Exact tested code is identified; differences are understood and approved. | ____ | ____ | ____ |
| IQ-002 | Run `node --version` and `npm --version`; compare Node with the repository CI configuration. | Supported versions recorded; differences approved before testing. | ____ | ____ | ____ |
| IQ-003 | Run `npm ci` from repository root. | Locked dependencies install successfully. Save the exit code and log. | ____ | ____ | ____ |
| IQ-004 | Owner checks test URL, database identity, migration inventory and backup/restore arrangements. Do not print secrets. | Disposable environment is confirmed; no real customer data; required schema is present. | ____ | ____ | ____ |
| IQ-005 | Owner provides fake companies A/B, admin, office, workshop and read-only support identities. Keep passwords outside evidence. | Access and company boundaries can be tested independently. | ____ | ____ | ____ |
| IQ-006 | Run `node tests/validation/check-pack.mjs`, `npm run typecheck` and `npm run lint`. | Pack links, TypeScript and lint pass; existing warnings are recorded and assessed. | ____ | ____ | ____ |
