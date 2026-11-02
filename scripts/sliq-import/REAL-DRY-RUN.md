# SliQ import: the REAL dry run (Rhys, on your own machine)

This runs the importer's **dry run** on JNR's real SliQ exports, on your own computer, against a **local throwaway database**
only. Nothing is written to Tolra, to any hosted project, or to the throwaway database (a dry run only reads). What you paste
back is made by `scripts/sliq-import/summary.mjs` and holds **only file names, column names, counts and totals**: no customer
or supplier name, no document number, no amount per customer or per document, and no row data.

Rules for the whole run:

- The real files stay on your machine, in a folder **outside** the repository (below: `~/sliq-dryrun`). Never copy them into
  the repo, a chat, a ticket or cloud storage.
- The only database is the throwaway one on `127.0.0.1`. The importer refuses any other host, and the throwaway database's
  name must contain `rehearsal`.
- Do **not** run `--write`. The real mapping (`mappings/sliq.json`) is provisional, so a write is refused by design until the
  mapping has been confirmed against your header rows (step 2).
- Paste back only the `.txt` files named in step 7. Never `report.md`, `report.json`, `ambiguity.csv`,
  `jobs-verification.csv`, `wip-verification.csv`, `dry.log` or any export file: those hold names, numbers and amounts.

## 0. What you need

- This repository checked out at the commit you were given, with `npm ci` run once.
- Node 20 or later, `bc`, and the PostgreSQL 16 client (`psql`, `pg_dump`): on a Mac `brew install libpq bc` and follow brew's
  note to put `psql` on your PATH.
- Docker, for the throwaway database (or a local PostgreSQL 16 that you can delete afterwards).

## 1. The export folder

Make the folder and put SliQ's exports in it, named as the real mapping expects (rename SliQ's files if needed):

```bash
mkdir -p ~/sliq-dryrun/export
# customers.csv suppliers.csv invoices.csv invoice-lines.csv (or document-lines.csv) payments.csv quotes.csv
# purchase-orders.csv credit-notes.csv allocations.csv products.csv jobs.csv sales-orders.csv wip.csv
# (.xlsx workbooks are read too; any file SliQ does not give is listed as "not supplied", not an error)
ls ~/sliq-dryrun/export
```

## 2. Send only the header rows first

```bash
cd <your checkout of the repository>
node scripts/sliq-import/summary.mjs headers ~/sliq-dryrun/export > ~/sliq-dryrun/headers.txt
cat ~/sliq-dryrun/headers.txt
```

Each line is `file: N data rows; columns: "Column A", "Column B", ...` (a worksheet as `book.xlsx [Sheet]: ...`). Read it before
you paste it: it should show only file names, row counts and column names. Paste `headers.txt` back. The mapping is then
confirmed (or corrected) against these exact headers before anything else, because the real mapping checks every header row
strictly: a missing or unknown column in any file stops the run with a list of column names.

## 3. The throwaway database (local, disposable)

```bash
docker run --rm -d --name tolra-dryrun -e POSTGRES_PASSWORD=localonly -p 127.0.0.1:5432:5432 postgres:16
export PGPASSWORD=localonly
DB=jnr_dryrun_rehearsal
scripts/sliq-import/rehearsal/build-db.sh "$DB"                      # stand-ins + every migration, about a minute
psql -h 127.0.0.1 -U postgres -X -q -d "$DB" -f scripts/sliq-import/rehearsal/setup-tenants.sql   # two made-up companies only
ORG=$(psql -h 127.0.0.1 -U postgres -X -At -d "$DB" -c "select id from public.organizations where slug = 'rehearsal-a'")
node scripts/sliq-import/cli.mjs prepare-rehearsal --database-url "postgresql://postgres@127.0.0.1:5432/$DB"
```

`build-db.sh` ends with `built jnr_dryrun_rehearsal: stand-ins + N migrations (000-136)`. The two companies are synthetic
(`rehearsal-a`, `rehearsal-b`); none of your data is in this database.

## 4. Dry run, files only

```bash
node scripts/sliq-import/cli.mjs ~/sliq-dryrun/export --mapping sliq --out ~/sliq-dryrun/r-dry > ~/sliq-dryrun/dry.log 2>&1; echo "exit $?" > ~/sliq-dryrun/exit-dry.txt
cat ~/sliq-dryrun/exit-dry.txt
node scripts/sliq-import/summary.mjs report ~/sliq-dryrun/r-dry/report.json > ~/sliq-dryrun/summary-dry.txt
```

`exit 0` means the dry run finished (a provisional mapping still finishes). `exit 2` means a file or header problem stopped
it: then there is no report; paste `exit-dry.txt` and `headers.txt` only, not `dry.log` (its message can quote a cell).

## 5. Dry run with the collision check against the throwaway database

```bash
node scripts/sliq-import/cli.mjs ~/sliq-dryrun/export --mapping sliq --out ~/sliq-dryrun/r-db \
  --database-url "postgresql://postgres@127.0.0.1:5432/$DB" --organization-id "$ORG" > ~/sliq-dryrun/db.log 2>&1; echo "exit $?" > ~/sliq-dryrun/exit-db.txt
node scripts/sliq-import/summary.mjs report ~/sliq-dryrun/r-db/report.json > ~/sliq-dryrun/summary-db.txt
```

This only reads the throwaway database (one read-only transaction).

## 6. Aged Debtors, to the penny

In SliQ, open the Aged Debtors report for the same day as the exports and note its **total** only. In `summary-db.txt`, the
line `Money owed after the import (total) ... Net (owed less credit): £...` must equal that total to the penny. Write one line
in `aged-debtors.txt`, for example `SliQ Aged Debtors total £160,932.45; summary net £160,932.45; equal: yes`.

What the summary gives (all counts or totals): files read with row counts and any unused or missing column names; the header
check; unreadable cells per file and column; rows per file; what would be written; numbers SliQ used more than once (copies and
renamed, per kind); held and needs-review counts; ambiguous or unmatched counts per kind (the rows themselves are in your local
`ambiguity.csv`, not in the summary); unresolved credit notes and payment exceptions; money owed, customer credit and net;
jobs, sales orders, purchase orders and opening WIP counts and the WIP total; whether the run is writable.

## 7. What to paste back

Only these files, after reading each one:

- `~/sliq-dryrun/headers.txt`
- `~/sliq-dryrun/exit-dry.txt`, `~/sliq-dryrun/exit-db.txt`
- `~/sliq-dryrun/summary-dry.txt`, `~/sliq-dryrun/summary-db.txt`
- `~/sliq-dryrun/aged-debtors.txt`

Keep `ambiguity.csv`, `jobs-verification.csv`, `wip-verification.csv` and the reports on your machine: they are what you and the
office checker work through to resolve each item (resolutions file, exclusions), and they name customers and documents.

## 8. Clean up

```bash
docker stop tolra-dryrun          # the container was started with --rm: the throwaway database is deleted with it
rm -rf ~/sliq-dryrun/r-dry ~/sliq-dryrun/r-db ~/sliq-dryrun/*.log
```

Keep or delete `~/sliq-dryrun/export` as you would any copy of JNR's data (it is the only copy outside SliQ on this machine).
