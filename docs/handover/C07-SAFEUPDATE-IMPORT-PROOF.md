# C07 — genuine pg-safeupdate import proof and handover

Builder 6 / L11 / 4 November 2026. Based on exact cutover candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. No production SQL or data used. This adds a targeted pull-request/manual CI job and a local runner; it does not merge or label anything Ready.

## Run the proof

Use a fresh dedicated checkout, Docker, the lockfile's Node dependencies and Supabase CLI **2.40.7** (the existing CI version):

```sh
npm ci
bash scripts/c07/run-safeupdate.sh
```

GitHub Actions: **C07 genuine safeupdate import proof** runs for changes to its workflow/runner/new test and can also be dispatched manually. It uses a fresh Ubuntu runner, Node 22, pinned CLI, read-only GHCR access and the existing full disposable Supabase bootstrap. Evidence is uploaded even on failure. It is not a production database or the existing broad release/CI gate.

The runner refuses an existing `.env.test.local`, inherited test URLs/keys/PGOPTIONS and existing `tolra-local-test` containers. It uses only the local Docker socket, creates the existing disposable loopback stack, and stops/removes its own stack on exit. Existing test isolation still verifies loopback/local JWTs, migration inventory and synthetic-only companies. It does not accept a target URL or silently reuse a backend. Use a dedicated checkout with no running local stack.

## Genuine extension requirement

`scripts/c07/enable-safeupdate.mjs` LOADs the actual installed PostgreSQL shared library (`LOAD 'safeupdate'`), requires `safeupdate.enabled = on`, sets the fresh disposable database's session preload, then opens a NEW connection and proves that preload is active without another LOAD. Unqualified UPDATE and DELETE must raise their real safeupdate errors; a qualified UPDATE is the positive control. The required DB test also proves PL/pgSQL refusal. No fake trigger/extension substitutes for the real library and no missing-library case can skip/pass.

The existing Supabase Postgres image supplies the library; the job does not pretend a JavaScript mock is an installation. If LOAD or preload fails, its exact PostgreSQL error is retained and the job fails before claiming import proof. The workflow then has to resolve its actual image/library/prerequisite problem, not disable enforcement. Enabling database session preload means every fresh direct test/importer connection is subject to safeupdate, including the real SliQ writer, not just a single probe session.

## Import paths and assertions

There are two distinct existing paths, and this report does not conflate them:

| Executed source | What it proves when actually passed |
| --- | --- |
| `tests/db/data-import-pr2.test.ts` | Existing credit/delivery import engine: `import_company_data`, stage/validate/commit-part/undo; invoice allocations/lines/delivery links; invalid data refusal, exact business-state undo and protection of later-used records; real safeupdate small/large branch. |
| `tests/db/c07-safeupdate.test.ts` | Mandatory active-library/refusal proof; credit+delivery payload normal import; dry run and invalid input leave full business rows/counters unchanged; an injected delivery INSERT failure after earlier kinds were processed leaves the prior business state intact; after removing only the test trigger, retry succeeds, repeat op and repeat payload add no duplicate business data; other company remains unchanged. |
| `tests/db/sliq-import.test.ts` | The existing SliQ CLI dryRun/writeRun/prepareRehearsal path uses `public.import_legacy_tenant` plus same-transaction line/payment writes; existing invalid/stale/repeat/mid-write-failure/isolation checks now run with safeupdate preloaded in its fresh connections. |

**The SliQ CLI does not carry credit notes/delivery notes through `import_legacy_tenant`.** Those are the existing migration-085 RPC import path used by the data-import UI; six SliQ reports remain comparison-only as documented in #320/L10. This job tests the real credit/delivery engine, and separately the real CLI, rather than inventing a nonexistent unified importer. The cutover owner must explicitly identify the approved actual route before treating either result as final SliQ transfer proof. Adding a new credit/delivery CLI writer is outside this job.

Dry-run/no-write checks refer to complete business rows and numbering, not an assertion that allowed audit/import attempt bookkeeping is absent. A failure does not have to erase its diagnostic evidence. Undo proof applies to the staged RPC import; no new unsupported SliQ CLI undo API is invented. The existing changed-after-import refusal assertions stay intact.

The JSON gate requires all three named files to execute, at least one assertion and every assertion passed: no failed, pending, skipped or empty proof is accepted. Existing assertions/tests are not weakened. This is a targeted PostgreSQL/runtime proof, not a full browser/hosted/provider/cutover validation.

## Actual validation status at initial publication

- Syntax: bash runner and Node activation script pass. Changed JS/TS ESLint with the unchanged explicit config passes. Candidate TypeScript `tsc --noEmit --incremental false` passes using supplied dependencies.
- Local Docker daemon is reachable. CLI npm installation first failed because the default npm cache is read-only; workspace cache was used, and the npm postinstall still exited 1. The official 2.40.7 release binary was then downloaded successfully and its version checked; there was no secret inspection or interactive login.
- **Actual backend start failed before PostgreSQL startup:** Docker image extraction reported `failed to register layer: openat nix/store/.links/1s9w5lp7279nansayd28slc4w804n4jypxd3xg73mw49hzyjzk0s: no space left on device`. No test SQL or library activation had run. A fresh runner attempt is recorded separately; its actual result must be retained, not treated as a pass.
- This is a local image-store extraction/storage-capacity failure, **not evidence that safeupdate cannot be installed in GitHub CI**. No CI success or CI library-install impossibility is claimed before the new workflow actually runs. The Actions artifact/start log will distinguish image pull/extraction, startup/migrations, library LOAD/preload and actual test failure precisely.

## Handover / remaining proof

Atomic `claims/L11`. Runner, real tests and workflow are committed as a draft; original candidate/source branches and migration bodies are untouched. CI/runtime outcome must be recorded on this exact PR head after running. Missing or failing DB proof stays P0 OPEN; source/lint/types are not a runtime pass. Code/reviewer must confirm the exact intended cutover route, complete passing no-skip proof and any discovered bug fixes before approval. No main merge, production SQL, deployment, Ready label or live import.
