# SliQ import rehearsal (tests/import)

A rehearsal of the SliQ import on **disposable copies only**, with **synthetic data only**. It proves customer matching, invoice totals, payments and document numbering on a database the real importer wrote, and ships a **read-only reconciliation report** (`reconcile.ts`).

Nothing here touches the real SliQ export, a hosted Supabase project, the JNREng project, Vercel, any provider, or any secret. Direct `pg` connections to a PostgreSQL 16 that you start yourself on 127.0.0.1:55511. No Docker, no Supabase CLI, no Auth API.

## Run it

```sh
tests/import/support/start-pg.sh            # initdb + start PG16 on 127.0.0.1:55511 under /var/tmp/sliq-rehearsal-pg (runs as the postgres OS user)
tests/import/support/build-template.sh      # shim + every supabase/migrations file into the template database sliq_rehearsal_tpl (about 10 s)
npx vitest run --config tests/import/vitest.config.ts
IMPORT_DEFECTS_STRICT=1 npx vitest run --config tests/import/vitest.config.ts tests/import/defects.test.ts   # see the defects red
tests/import/support/start-pg.sh stop       # stops the server and DELETES its data directory
```

`tests/import/vitest.config.ts` includes only `tests/import/*.test.ts`. The main suite (`vitest.config.ts`) and the database suite (`vitest.db.config.ts`) never pick these up, and these never need the Docker backend. If the server or the template is missing, or the URL is not on this machine, the tests **fail with instructions** (`missing-database.test.ts` proves it); they never skip and never fall back. Environment overrides: `IMPORT_REHEARSAL_ADMIN_URL` (default `postgresql://postgres@127.0.0.1:55511/postgres`, must be loopback) and `IMPORT_REHEARSAL_TEMPLATE` (default `sliq_rehearsal_tpl`).

Each test file gets its own throwaway copy (`CREATE DATABASE sliq_rehearsal_<file>_<random> TEMPLATE sliq_rehearsal_tpl`), a synthetic company made with the app's own `public.create_organization`, runs the importer's whole path (prepare rehearsal copy, dry run against it, write guards, one-transaction write), and drops the copy afterwards. The importer's own URL guard (`checkDatabaseUrl`: loopback or a name containing `rehearsal`/`disposable`) screens every URL as well.

## What is reused (not rewritten, not contradicted)

| Reused | From |
|---|---|
| The importer itself: `dryRun` / `writeRun` / `prepareRehearsal` / `loadFolder` / `analyse` (pre-write report, guards, rehearsal identity, one-transaction write through `public.import_legacy_tenant`) | `scripts/sliq-import/*` |
| The provisional SliQ header guess (`Company Name`, `Number`, `Customer`, `Invoice Date`, `Net`/`VAT`/`Gross`, `Invoice Number`/`Amount`, ...) | `scripts/sliq-import/mappings/sliq.json` (copied into `support/rehearsal-mapping.json`, plus `Line Net` / `Line VAT`) |
| The importer SQL, counter reseed (`sliq-scoped-reseed`), `legacy_import_map`, the 140 `source_ref` and 141 opening-WIP objects, `next_doc_number` | `supabase/import/import_legacy_tenant.sql`, `supabase/migrations` (all 120 files, including 140 and 141) |
| The loopback / production-ref guard and its error type | `tests/support/isolation.ts` (`assertLoopbackUrl`) |
| The plain-`pg` approach and the Supabase stand-ins (roles, `auth.users`, `auth.uid()`) | `/tmp/claude-0/s/r151/build-db.sh` and `local-shim.sql` from the g30 mock-prod work (copied to `support/local-shim.sql`; the repo has none) |

Studied and deliberately **not** duplicated:

- `tests/unit/sliq-import*.test.ts`, `sliq-risk-guards`, `sliq-reconcile*`, `sliq-archive` and `tests/fixtures/sliq/*`: DB-less checks of parsing, mapping, the report and the write guard on a small hand-made fixture. This rehearsal starts where they stop: the rows the importer actually wrote.
- `tests/db/sliq-import-preflight-140-141.test.ts`: the 140/141 release markers and verify files. Untouched; this suite only relies on 140/141 being in the migration chain.
- `tests/db/data-import*.test.ts` and `tests/unit/data-import*`: the workbook importer (`import_company_data`, migration 076), a different path. The N3 rehearsal (`origin/codex/b5-n3-sliq-rehearsal`: `scripts/n3`, `tests/N3-SLIQ-REHEARSAL.md`, nine checks, counts-only artifacts, CI workflow) also exercises that workbook path and is CI-shaped; this suite does not need CI or Docker and covers the `scripts/sliq-import` path instead. They do not overlap.
- `scripts/sliq-reconcile/*` (offline source-to-target reconciler for the real export): this suite's `reconcile.ts` is smaller and test-side, a post-write check on a disposable copy. It does not replace that tool.
- `origin/claude/sliq-rehearsal` (`scripts/sliq-import/rehearsal/*`, one commit on an older base): a 2,035-invoice volume rehearsal with generate / checks / run-sheet scripts. Not in this tree; it is the volume and timing rehearsal. This one is the small, assertion-heavy, repeatable one.

## What is new

- `support/synthetic.ts`: the synthetic export generator (below). `support/db.ts`, `support/world.ts`: disposable-copy plumbing, the importer run, the "world" most files start from.
- `customer-matching.test.ts` (16 tests): spellings to one customer, near names never merge, duplicates reported and kept, unknown customer held, a customer the company already has flagged and added separately.
- `invoice-totals.test.ts` (11): net, VAT, gross to the penny against the generator's own pence, lines add up, VAT per line against header (rounding listed), every mismatch listed in both reports.
- `payments.test.ts` (16): full, split, part, over-, duplicate, zero, undated, draft/void and unallocated payments; every penny of source cash accounted for.
- `numbering.test.ts` (11): numbers preserved verbatim (`00045`, `SI/2026/0007`), counters after the import, the company's next number, gaps and duplicates, a number the company already used, a counter already ahead, a second company untouched.
- `reconcile.ts` + `reconcile.test.ts` (21): the read-only reconciliation, its read-only proofs, and a tamper test per check.
- `defects.test.ts` (3, `it.fails`): importer defects, below. `missing-database.test.ts` (5): fails loudly.

## Synthetic fixtures: how they are made

`support/synthetic.ts` `buildScenario(seed = 20261106)` writes everything from a fixed-seed PRNG (mulberry32) plus a hand-written list of awkward cases: 33 customers (13 named cases including a duplicated record and near names, 20 bulk), 75 invoice rows (a duplicate number, an unknown customer, a missing number, a high number, `00045`, `SI/2026/0007`, 40 consecutive seeded bulk invoices), 133 lines, 57 payments, 3 quotes. Names are `Alpha Fabrications Ltd`, `Bulk Customer 07 Ltd` and the like, e-mail `*@example.test`, phone `0100 000 nnnn`. Same seed gives byte-identical files. `writeExport()` writes the CSVs with the provisional SliQ headers. The scenario object also carries the amounts in pence as generated: that is the independent truth the tests compare the database with (not the importer's parse). The real SliQ export is never read, copied or imitated beyond the header guess already in the repo.

The mapping file is marked `confirmed` **only so the importer's write guards run end to end on synthetic data**. It says nothing about the real headers.

## Importer behaviours these tests pin (read before relying on them)

- Customers: matched by normalised name (case, spacing, punctuation, `&`/`and`, `Ltd`/`Limited`). Two records that normalise alike are **both kept**, reported, and invoices go to the **first**. `Epsilon Welding` and `Epsilon Welding Services` never merge. An existing company customer with the same normalised name is flagged for review and the import adds a separate record.
- A header net **lower** than the lines' net, or two invoices sharing a number (their lines pool), is flagged as a possible discount and **blocks the whole write** until each is excluded by number (`--exclude`). The scenario excludes `INV-0110` and `INV-0124` for that reason.
- **Header gross not equal to net + VAT (INV-0123: 120.01 against 100.00 + 20.00) is written as stated**, listed in the pre-write report and by `reconcile.ts` (`invoice_internal_total`), but does not block the write. This may be intended ("reported, not blocked"); it is pinned, not asserted as right.
- Payment state comes from the payments file only. A `Paid` status word with no payment rows is not paid. Overpaid, duplicated, zero, undated and credit-allocated invoices get **no payment rows** and are marked Payment to confirm. Payments against a draft or void invoice are not imported. Payments for an invoice not in the file are listed and written nowhere.
- Numbers are kept verbatim. Duplicate numbers are **held, not renumbered**: release 140's header describes a `-B` renumber with the SliQ number in `invoices.source_ref`, but the importer does neither (`source_ref` is empty on every row; pinned in `numbering.test.ts`, so wiring it later fails that test on purpose). Counters (`INV`, `QUO`, and `J` from `QUO-n` as in migration 006) are raised to the highest `PREFIX-digits` number of the target organisation only, never lowered; `next_doc_number` also skips any number that exists.

## Defects found (importer code not changed; each has a failing test in `defects.test.ts`)

1. `scripts/sliq-import/ids.mjs:32` (`normaliseName`): `.replace(/[^a-z0-9 ]+/g, " ")` deletes every letter outside ASCII that NFKD does not decompose. `Мир Ltd` and `Дом Ltd` both become `ltd`, so two different customers are treated as one: the second one's invoices are filed under the first (`reconcile.mjs` `parties().resolve()` takes `[0]`), and the pair is only "reported" as a duplicate name. Same for `Łukasz Ltd` = `ukasz Ltd`, `Østergaard`, `Ð...`. Low frequency for a UK customer base, wrong-customer-on-an-invoice when it happens.

## What is proven, and what is not

Proven on a disposable PostgreSQL 16 with the full migration chain (000 to 144, including 140 and 141), synthetic data, through the real importer:
the four areas above and the reconciliation report (counts, totals, discrepancy list, read-only by statement guard + `BEGIN READ ONLY` + a before/after content fingerprint of every table and sequence, with negative controls); that each check can fail (a tamper per check, and four one-line mutations of the importer or its SQL were each caught, then reverted); that a missing database fails loudly.

**Not proven:**
- Anything about the **real SliQ export**: its real headers (the mapping is a guess), encoding, date format, status words, VAT codes, credit notes, discounts, reverse charge, numbering style, volume. No real data was read.
- **Credit notes and allocations**, purchase orders, suppliers, stock, quotes' lines, jobs: out of scope here (credit notes are held by the importer; quotes only for count/total/number).
- **Volume and timing** (JNR's ~2,000 invoices): see `origin/claude/sliq-rehearsal`; this scenario has 71 imported invoices.
- **Production or the hosted Supabase**: the shim replaces Supabase's auth/storage/roles; row-level security as PostgREST applies it, the Auth API, MFA and the app UI/API are not exercised. The importer runs here as the database owner, as it would for the real run, not as an app user.
- **Re-run / idempotency, crash mid-write rollback, backup restore**: not rehearsed here (see the `origin/claude/sliq-rehearsal` run sheet).
- Payment dates before invoice dates, currency other than GBP, amounts beyond `numeric(12,2)`.
- `reconcile.ts` is a test-side tool for the disposable copy. It is not the offline reconciler for the real export (`scripts/sliq-reconcile`) and has not been run against real data. It trusts `legacy_import_map` to say which invoices the import created.
- No CI run, no push: the suite was run only on this machine.
