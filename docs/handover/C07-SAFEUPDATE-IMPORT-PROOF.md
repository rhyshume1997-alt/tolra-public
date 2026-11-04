# C07 — genuine pg-safeupdate import proof and handover

Builder 6 / L11 / 4 November 2026. Based on exact cutover candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. No production SQL or data used. This adds a targeted pull-request/manual CI job and a local runner; it does not merge or label anything Ready.

## Latest result — targeted runtime proof PASSED

[Actions run 41871020772](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41871020772) completed **successfully**. Tested source: `db75ea2ec941f194b7e96f77b0e015267d201cf7`; actual PR test merge: `62af6ae1655e55a09fae81e4da611b4990ba10fa`, into pinned base `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. Fresh-session genuine library preload, unsafe UPDATE/DELETE refusal and qualified control passed. All **25 tests across the three required files passed, zero skipped/pending**; the mandatory new test includes PL/pgSQL refusal and mid-write failure recovery. The JSON gate ran successfully; the disposable stack cleanup completed.

[Artifact 13344811572](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41871020772/artifacts/13344811572): `c07-safeupdate-evidence`, ZIP SHA-256 `294f92b8a4a4a85b69d0141eec6699f71788df70df80044ffc8015aa6e083cc3`. Contains startup, active-library, full test/JSON and cleanup records. The final publication adds this evidence text only; executable code/tests/workflow remain the tested source. Earlier failed attempts below are historical, not alternate passing evidence.

**Safeupdate is available and active in this CI image.** The initial plain LOAD failure was a non-superuser restriction, not inability to install it. The fix configures scoped preload through the fresh local bootstrap administrator without promoting the importer or altering production roles. This targeted pass clears the missing-runtime-proof gap for these paths; it is not a full release/hosted/browser validation or approval of an unconfirmed final SliQ route.

## Run the proof

Use a fresh dedicated checkout, Docker, the lockfile's Node dependencies and Supabase CLI **2.40.7** (the existing CI version):

```sh
npm ci
bash scripts/c07/run-safeupdate.sh
```

GitHub Actions: **C07 genuine safeupdate import proof** runs for changes to its workflow/runner/new test and can also be dispatched manually. It uses a fresh Ubuntu runner, Node 22, pinned CLI, read-only GHCR access and the existing full disposable Supabase bootstrap. Evidence is uploaded even on failure. It is not a production database or the existing broad release/CI gate.

The runner refuses an existing `.env.test.local`, inherited test URLs/keys/PGOPTIONS and existing `tolra-local-test` containers. It uses only the local Docker socket, creates the existing disposable loopback stack, and stops/removes its own stack on exit. Existing test isolation still verifies loopback/local JWTs, migration inventory and synthetic-only companies. It does not accept a target URL or silently reuse a backend. Use a dedicated checkout with no running local stack.

## Genuine extension requirement

`scripts/c07/enable-safeupdate.mjs` uses the fresh container's existing bootstrap `supabase_admin` to configure real `safeupdate` session preload for `postgres` in this disposable database only, preserving existing preloads. It then opens a NEW non-superuser connection and requires `safeupdate.enabled = on` without a restricted ad-hoc LOAD. Unqualified UPDATE and DELETE must raise their real safeupdate errors; a qualified UPDATE is the positive control. The required DB test also proves PL/pgSQL refusal. No SUPERUSER/BYPASSRLS grant is added. The existing safeupdate availability helper and PR2 branch accept an already active library rather than issuing a redundant denied LOAD; the PR2 connection still explicitly requires on, and the new mandatory probes prove enforcement. No fake trigger/extension substitutes for the real library and no missing-library case can skip/pass.

The existing Supabase Postgres image supplies the library; the job does not pretend a JavaScript mock is an installation. If preload configuration/loading fails, its exact PostgreSQL error is retained and the job fails before claiming import proof. The workflow then has to resolve its actual image/library/privileged-setup prerequisite problem, not disable enforcement. Enabling database session preload means every fresh direct test/importer connection is subject to safeupdate, including the real SliQ writer, not just a single probe session.

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
- A second correctly configured local runner attempt failed at the same Nix-store extraction error before PostgreSQL startup; the earlier command-not-found runner invocation was corrected by selecting the downloaded CLI. The inherited TEST_DATABASE_URL guard was also exercised and refused before starting a backend.
- First targeted CI [41868371152](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41868371152), on source head 6abb918 / synthetic merge f04cb943, **failed** after starting PostgreSQL: `access to library "safeupdate" is not allowed`, SQLSTATE 42501, `dfmgr.c:473 check_restricted_library_name`. Dependency install/CLI/registry/startup succeeded; no import test passed. [Artifact 13342663781](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41868371152/artifacts/13342663781) retains the logs. This is the non-superuser ad-hoc LOAD restriction, not evidence the library is unavailable or cannot be installed in CI.
- Follow-up uses only the fresh container's existing bootstrap administrator to set the scoped preload; it does not promote the importer or weaken its authenticated roles. Re-run must prove actual fresh-session enforcement and all tests; no corrected runtime pass is pre-filled.

## Handover / remaining proof

Atomic `claims/L11`. Runner, real tests and workflow are committed as a draft; original candidate/source branches and migration bodies are untouched. The latest section records actual matching CI runtime evidence; initial failed setup attempts are preserved below. Source/lint/types alone were not treated as a pass. Confirm the exact intended final route and independent review before closing the reviewer P0 as a release decision. Code/reviewer must confirm the exact intended cutover route, complete passing no-skip proof and any discovered bug fixes before approval. No main merge, production SQL, deployment, Ready label or live import.

### Second CI setup result and correction

Run [41869503806](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41869503806), source 55bcb05, failed before activation/import tests: bootstrap psql used socket password authentication and answered `fe_sendauth: no password supplied`. The scoped preload SQL was not applied. Follow-up passes only the freshly generated local stack password through stdin to that container's bootstrap connection, never argv/logs; importer roles remain unchanged. This corrects setup rather than disabling any test or enforcement. Runtime proof remains open until the corrected run completes.

### Third CI setup result and correction

Run [41870299593](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41870299593), source 55b97b3, authenticated bootstrap and applied the role setting, but the fresh connection failed with `could not access file "supautils,safeupdate": No such file or directory`. ALTER ROLE had encoded the comma-joined value as one quoted library item. Follow-up sets two separately quoted configuration-list entries, preserving supautils and adding safeupdate. No enforcement or assertion was removed; import proof remains unrun until activation succeeds.
