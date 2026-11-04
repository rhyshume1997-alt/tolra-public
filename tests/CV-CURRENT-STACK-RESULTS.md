# CV: current candidate and held CM checks

Local checks on 4 November 2026: **PASS** for lint, typecheck and the complete unit suite in both scopes below. These are local results, not a full CI, database, browser, provider or release approval.

| Scope | Exact tested commit / tree | Unit result | Files | Lint / typecheck |
| --- | --- | --- | --- | --- |
| Latest-main-containing builder 3 candidate | `e7581c43b5f92836ceaedcf2716d495392a9d9e6` / `a1c21e014ef0e7c201dc48d5f61b09bebd1f9ffc` | 5,622 passed; 0 failed, skipped or todo | 415 passed | Both exit 0; lint 0 errors, 3 existing warnings |
| CM isolated held-costing follow-up #285 | `a4c89af3723703ba5e284bb6500553d42975f925` / `e211077d6f77b10f39220e90085536ace911658b` | 5,357 passed; 0 failed, skipped or todo | 373 passed | Both exit 0; lint 0 errors, 3 existing warnings |

Latest public main was `68f89ca7b801a10587ff9b51d6c820462847b65a` when preparing and after completing these runs. GitHub compare confirmed it is an ancestor of the candidate. This is one combined candidate run plus the separate incompatible CM held-branch context, not a repeat of the stopped historical 61-head audit. Exact Git trees were reconstructed and checked against every tracked blob; working trees were clean before/after. The reporting commit adds evidence after the tested commit; it is not a claim that a different head was executed.

The candidate contains the builder 3 spine through CU (CJ, CG/CK, CH, CL, CQ, CR's initial corrections, CS, CT, CU) and the CN/CO/CP sibling documents. Its integration parents are CU `73e35550b41df9f7799bf20c24b4b47b05438780`, CN `50b1877982808084aed13b2c0eced461d48dd7f6`, CO `4b134cbb3f04f63938ef4537e122a43b8af6235f` and CP `ce2e6cc1268e5965a490f839083ab0fcd17eeae7`. The later CR report extension for #314 and builder 4's corrected CN/CU wording are outside this frozen tree. Retain #314's corrections when combining the final papers; no runtime result is transferred to that future head. Code's diagnostic f76a5b84 validation refresh is an evidence source, not integrated application code.

## Exact commands

Candidate, working directory `/workspace/work/cv`:

```sh
npm ci --no-audit --no-fund --cache /workspace/work/npm-cache
npx eslint app components lib tests/e2e/acceptance tests/unit/money-rounding-rule.test.ts tests/db/money-rounding-parity.test.ts tests/fixtures/money-rounding-cases.ts
npm run typecheck -- --pretty false
npm test -- --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/workspace/work/queue-cr/cv-candidate-locked-unit.json
```

CM, working directory `/workspace/work/cm`:

```sh
npx eslint app components lib tests/support/costing-proposal-setup.ts tests/unit/costing-proposal-setup.test.ts
npm run typecheck -- --pretty false
npm test -- --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/workspace/work/queue-cr/cv-cm-unit-permitted.json
```

Node `v24.22.1`, npm `11.9.0`. Candidate uses a fresh locked install (856 packages); lockfile SHA256 `ca89ac67b8ef4395469460f11153f33132a3f064705e5cc5f5bf047272684248` stayed unchanged. CM uses the supplied preinstalled dependency directory, not a fresh locked-install proof. Successful unit runs used the execution tool's additional network permission so child processes and loopback fixtures could run. No external production SQL or backend was involved.

Existing lint warnings in both contexts: missing `viewer?.profile` dependencies in `components/job-photos.tsx:58` and `components/rework-dialog.tsx:217`, unused `_buildId` in `lib/offline/outbox.ts:446`. They were not suppressed or changed. File counts above come from reporter file entries; Vitest's nested describe-suite totals (1,636 / 1,523) are not test-file counts.

## Failed attempts retained

1. Initial restricted runs: candidate 5,609 passed / 13 failed; CM 5,350 passed / 7 failed. Child-process/loopback permission errors included `spawnSync node EPERM`. Both lint and typecheck already exited 0. These were failures, not skips or passes.
2. Unchanged-source retry with the supported permission: CM 5,357 passed, exit 0. Candidate 5,621 passed / 1 failed, exit 1: the supplied dependency directory lacked the locked Barlow Condensed font file required by `marketing-local-fonts.test.ts`.
3. Candidate clean install first failed because the default home npm cache was read-only. Retrying with the writable workspace cache succeeded. Re-running all three commands against unchanged candidate source then produced the passing 5,622 result above. No assertion, test, implementation or lockfile was weakened.

Summaries, successful command logs, installation logs and per-file assertion counts are committed under [evidence/builder-3-cv/](evidence/builder-3-cv/). Each reduced unit report records the SHA256 of the original local JSON reporter artifact. Earlier summary files retain exact failed counts/commands and failure messages. These results do not clear missing Operations Pack coverage, actual SQL parity, browser/manual PQ, provider, backup/import, unsigned VSR or independent review conditions. CM does not activate costing or alter its protected half-even engine/rates/golden answers. No main merge, production SQL, Ready label or deployment.
