# C07: genuine pg-safeupdate import proof (manual CI job)

Branch `claude/c07-safeupdate-ci`, based on the cutover candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. It rebuilds Codex draft #355 (`codex/b6-l11-c07-safeupdate`, which stays untouched) with the reviewer's defects fixed. It adds no app code, no migration and no edit to an existing test. Data is synthetic only. No hosted database is used.

## Run

GitHub Actions: **C07 genuine safeupdate import proof**. It has `workflow_dispatch` only, so a push or a pull request never starts it. It runs on a fresh Ubuntu runner with Node 22, Supabase CLI 2.40.7, and the job's own read-only token for the ghcr.io image pulls. It reserves the same ports and starts the same `scripts/test-backend.sh start` stack as `ci.yml`. It uploads the evidence in `work/c07-*/` even when the job fails. The evidence holds no password.

Local run: use Docker, a fresh dedicated checkout and PostgreSQL 17 server headers.

```sh
npm ci
PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config bash scripts/c07/build-safeupdate.sh /tmp/safeupdate
SAFEUPDATE_BUILD=/tmp/safeupdate bash scripts/c07/run-safeupdate.sh
```

The runner refuses all of these: inherited `TEST_*`, `PGOPTIONS` or `SLIQ_IMPORT_DATABASE_URL` variables; an existing `.env.test.local`; and any existing `tolra-local-test` container. When it exits, it stops and removes its own stack.

## The library

- **What the image ships.** CLI 2.40.7 starts `supabase/postgres:17.6.1.002`. That image's `nix/ext/pg-safeupdate.nix` (supabase/postgres at tag 17.6.1.002) builds pg-safeupdate **1.4** (`rev = version`). The job records that file's path and target in the evidence but does not use it.
- **What the job uses.** `scripts/c07/build-safeupdate.sh` fetches eradman/pg-safeupdate at **`37dbc9c4acf5e2504adf2b218e9c6b41751022f3`**, which is tag 1.7. It fails unless HEAD is that commit and NEWS and the Makefile both say 1.7. It then builds against the PGDG PostgreSQL 17 headers and records the commit, version and sha256 values in `BUILD-INFO`.
- **How the job installs it.** `scripts/c07/enable-safeupdate.mjs` runs as the container's bootstrap `supabase_admin` and does five things:
  1. It copies the build into `/usr/local/lib/c07-safeupdate/` and checks that the bytes in the container match the build's sha256.
  2. It sets `ALTER SYSTEM SET dynamic_library_path = '/usr/local/lib/c07-safeupdate:$libdir'`, so every new session resolves `safeupdate` to the pinned build.
  3. It adds `safeupdate` to the postgres role's `session_preload_libraries` in this database and keeps any existing entries.
  4. It restarts PostgREST so that API sessions reload the library.
  5. It creates the disposable login `c07_direct_superuser` (explained below).
- **What the job proves.** It prints the library path, version, commit and sha256. It shows the `/proc/<pid>/maps` file mapped by each kind of session: a new postgres (importer) session with no LOAD, a direct-session `LOAD 'safeupdate'`, and every PostgREST (authenticator) session. Each one must be exactly the pinned file. It prints `SHOW session_preload_libraries` (or its refusal, since that setting needs `pg_read_all_settings`) and the role settings. It also prints the real errors that a bare UPDATE, a bare DELETE and a PL/pgSQL UPDATE raise, both as the importer role and as `authenticated`. It asserts each exact message, plus a qualified-UPDATE control.

## Roles and transaction strategy of the cutover paths

| Path | Role | Transaction |
| --- | --- | --- |
| SliQ legacy CLI (`scripts/sliq-import/cli.mjs --write`) | The database URL's own role (the owner; `postgres` on the stack) on one direct `pg` connection (`write.mjs:21-33`) | One transaction: `begin` (`write.mjs:161`), `pg_advisory_xact_lock` (162), `import_legacy_tenant` (188) plus the line and payment writes, `commit` (255), `rollback` on any error (258). It has no undo; the rollback is the transaction. It writes no credit notes (`resolutions.mjs` header) and no delivery notes (`write.mjs:147`, `delivery_notes: []`). |
| Data import, Admin > Data (`lib/data-import.ts:126,141,161,178`) | `authenticated` admin through PostgREST, which reaches SECURITY DEFINER entry points (076) | A small import is one call and one transaction under the per-company lock (`076_data_import.sql:1638`). The work runs in a sub-block (1647-1657), and a dry run or any problem rolls all of it back. An unexpected error becomes one problem (1655-1656). A dry run records only its `import_batches` row (1659-1666). A large import is staged, validated as a whole, committed one part per transaction, and undone one part per call (076 header, section 6b). Credit notes and delivery notes use only this path (085). |

140's `source_ref` can be written only by the owner or service role (the `source_ref_import_only` trigger). The CLI at this head does not write it.

## What runs, and the gate

1. **Direct sessions as `c07_direct_superuser`** (`TEST_DATABASE_URL` is overridden for this run only). The files are `tests/db/data-import-pr2.test.ts` and `tests/db/data-import-safeupdate.test.ts`. `LOADABLE` (`tests/db/safeupdate-support.ts`) is true only for a user that may `LOAD 'safeupdate'`. PostgreSQL limits a non-superuser to `$libdir/plugins/...` names, and Supabase's postgres role is not a superuser (#355's run 41868371152: 42501 from `check_restricted_library_name`). These suites therefore get a disposable superuser login. That login LOADs the real library, then `become()` switches to `authenticated` before every import call. `API` is true because the stack's `.env.test.local` exists.
2. **The importer role (`postgres`), with safeupdate preloaded and no LOAD.** The files are the new `tests/db/c07-safeupdate.test.ts` and the existing `tests/db/sliq-import.test.ts`.

`scripts/c07/gate.mjs` requires each of the four files to run in its expected report with at least one test, and every test in them to be `passed`. It also requires each of these tests to appear by name exactly once and pass:

- `data-import-pr2.test.ts > with pg-safeupdate loaded (as in Supabase's API sessions) > the small and the large path, credit notes and delivery notes included, then undo`
- `data-import-safeupdate.test.ts > in a direct session with safeupdate loaded >` each of:
  - `safeupdate is in force in these sessions: …`
  - `small file: a dry run …`
  - `small file with a problem: …`
  - `large file: …`
- Also by name: the three `through the API (PostgREST: safeupdate preloaded by Supabase)` tests, and `is checked somewhere: …`.

The new C07 suite covers the following:

- A fresh importer-role session has safeupdate on without a LOAD.
- **Data import:**
  - A dry run writes no business row; its only audit row is its own `import_batches` dry-run row.
  - An invalid file (a credit note over its invoice's total) is refused, with no change to business rows, audit or batches.
  - A delivery-note INSERT failing midway, after customers, invoices and the credit note were written, rolls everything back with no audit or batch row. A retry with the same key then commits once (credit note, allocation and delivery-note items checked). The same key then replays, and the same file under a new key matches everything (0 created).
  - `source_ref` stays NULL.
  - A large import with credit and delivery notes, committed part by part and then undone, returns the company exactly to its earlier records with none lost. A re-import then creates each record once.
- **SliQ CLI:**
  - A dry run leaves business rows, the legacy map and the audit log identical.
  - A payment INSERT failing midway rolls back the whole transaction. The retry writes it once. A repeat adds nothing.
  - The owner may set `source_ref`, and the signed-in admin can neither set nor change it (42501, `source_ref_import_only`).

## Status

- **Proved locally (this sandbox):**
  - TypeScript `tsc --noEmit` passes.
  - ESLint passes on the new TS and JS files.
  - `bash -n` and `node --check` pass on the scripts.
  - actionlint 1.7.7 is clean and the workflow parses with `workflow_dispatch` as its only trigger.
  - `vitest list` collects the new suite's 8 tests without a database.
  - The gate passes a complete synthetic report and fails one with a skipped target and one with a missing target.
  - `build-safeupdate.sh` fetched and verified 37dbc9c and built it against PostgreSQL **16** headers. In a scratch PostgreSQL 16 cluster, with the same `dynamic_library_path` and role-preload mechanism, a non-superuser session mapped the pinned file. Its bare UPDATE, bare DELETE and PL/pgSQL UPDATE were refused with the exact messages, the qualified forms passed, and a bare `LOAD 'safeupdate'` was refused for the non-superuser.
- **Not run here:** this sandbox's proxy refuses the Supabase image blobs (ghcr.io and public.ecr.aws return 403, Docker Hub returns 429), so the stack cannot start. Not one database test, enable step or gate run against the stack has run anywhere. Nothing here is a pass. A missing or failing proof stays open until the dispatched job's evidence shows it.
- **Risks to check in the first dispatched run:**
  - The PGDG-built library loading into the image's Nix PostgreSQL 17.6. The local build needs no versioned glibc symbols.
  - `supabase_admin` access over the container's loopback.
  - PostgREST coming back after its restart.
  - The two existing direct-session files running entirely as a superuser login rather than `postgres`. Only their own `become()` calls switch to `authenticated`.
  - The strict row-for-row assertions in the new suite.
