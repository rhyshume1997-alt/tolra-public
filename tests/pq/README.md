# PQ environment: a disposable company with synthetic JNR data

A throw-away database full of **invented** JNR-style work, so a PQ (the acceptance practice run in `tests/validation/PQ.md` and
`tests/JOHN-PQ-RUN-SHEET.md` on the `codex/cn-john-pq-run-sheet` branch) can be rehearsed without touching real data. It is built on
the repo's normal disposable Supabase stack (`npm run test:backend`) and refuses to run against anything else.

Nothing here is in the main test suite, CI, a migration or the app. It has its own vitest config. It does not edit the PQ documents.

## What it reuses, what is new, what is unproven

**Reused (not copied, not weakened)**

| From | How |
| --- | --- |
| `scripts/test-backend.sh` / `.env.test.local` | The only stack it talks to. Same variable names (`TEST_DATABASE_URL`, `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`). |
| `tests/support/isolation.ts` | Same production-project refs, same loopback rule, same hosted-key (`ref` claim) rule, same `t-` synthetic slug prefix. `guard.test.ts` runs the repo's guard and ours side by side on the same URLs so they cannot drift apart. |
| `tests/support/fixtures.ts` `verifyBackendIdentity` | Same three refusals (no `supabase_migrations` table; any organisation whose slug is not `t-...`), re-implemented in plain ESM because the shell scripts run under `node` with no build. `destroySyntheticWorld` is the model for the reset (replica mode in one transaction, then auth users with triggers back on). |
| `createSyntheticWorld` conventions | `@example.test` addresses, `t-<8 hex>-<name>` slugs, admin ticked as inspector, Sales Orders switched on, `create_organization` + `add_member` for users. |
| The product's own functions | `create_organization`, `add_member`, `next_doc_number`, `create_with_lines`, `accept_quote` (which makes the sales order and job), `create_job`, `save_machine_booking`, `inspect_job`, `despatch_lines`, `create_delivery_note` (despatching drafts the invoice), `issue_invoice`, `record_invoice_payment`, `create_credit_note` / `issue_credit_note`, `set_archive_state`. Each runs as the company's own user (`SET LOCAL ROLE authenticated` plus JWT claims), so roles, totals checks, locks and the audit trail apply exactly as in the app. |
| `supabase/fixtures/demo_documents.sql`, `scripts/demo-seed`, `scripts/seed-tolra-demo.ts` (other branches) | Ideas only: invented names, `example` addresses, penny-exact money, a loopback-only refusal with an explicit confirmation flag. None of them is imported; they make a few round-number screenshot records, this makes a working company. |
| `tests/pq/support/local-pg-shim.sql` | A copy of the Supabase stand-in used for local migration proofs (`scripts/mock-prod/local-shim.sql` on another branch). Used only by the plain-PostgreSQL proof below. |

**New (all under `tests/pq/`)**

- `seed/generate.mjs`: a pure, seeded generator (fixed PRNG, no clock, no network). One call returns the whole dataset as JSON.
- `seed/load.mjs`: loads it through the functions above. `seed/verify.mjs`: database-side PQ checks. `seed/reset.mjs`: marker-tagged removal.
- `seed/guard.mjs`, `seed/cli.mjs`, `setup.sh`, `reset.sh`, `verify.sh`.
- `support/build-local-pg.sh` (+ shim): builds the migrations on a bare local PostgreSQL 16, for the Docker-free proof only.
- Tests: `generate.test.ts`, `guard.test.ts`, `pg-load.test.ts`, run by `vitest.config.ts`.

**Unproven (could not be run where this was written: no Docker, no Supabase CLI, no Auth API, no browser)**

- `npm run test:backend` and a load into the real Supabase stack. The loader talks to it by the same SQL it ran on plain PostgreSQL 16, but that stack was not available.
- `--auth api` (creating real, sign-in-capable users through the Auth admin API). The code path exists and is guarded; it has not been executed.
- Anything through PostgREST, Kong, the Next.js app or a browser: sign-in, MFA, the screens, printing, e-mail, accounting connectors, AI. The PQ steps that need those are listed below as manual.
- `scripts/test-backend.sh reset` (used by `reset.sh --recreate`).
- CI: no workflow runs this and none was added.

## Prerequisites

- Node 22, `npm ci` (needs the `pg` driver already in `node_modules`).
- Docker and Supabase CLI **2.40.7** (the version `scripts/test-backend.sh` insists on) for the real thing.
- Nothing else: no keys, no hosted project, no network access.

## Setup

```sh
npm run test:backend                       # starts the disposable stack, writes .env.test.local (loopback only)
tests/pq/setup.sh --yes-this-is-a-disposable-database \
    [--seed pq-jnr-1] [--base-date 2026-11-02] [--scale 1] [--auth sql|api]
tests/pq/verify.sh --yes-this-is-a-disposable-database      # the database-side PQ checks (read-only)
```

- `--base-date` defaults to today (UTC). It is the single anchor for every date; the value used is printed and recorded in `.env.pq.run`.
- `--scale N` (1 to 50). 1 is the test size (about 25 quotes, 30 invoices, 240 time events); 10 loaded in about 11 seconds on plain PostgreSQL 16.
- `--auth sql` (default) inserts `auth.users` rows only. Enough for every database check; **you cannot sign in with them**.
  `--auth api` creates the users through the local stack's Auth admin API, so the UI can be used; passwords are random, written once to
  `.env.pq.credentials` (git-ignored by `.env*`), and are valid only on that throw-away stack.
- A second run with the same seed stops ("already loaded") without writing. Use another `--seed` for a second company set, or reset first.
- A load that fails part-way is taken back (its tagged rows are removed) and the failure reported.

To see the data without a database: `node tests/pq/seed/cli.mjs generate --base-date 2026-11-02 --scale 1 > pq.json`.

## Reset

```sh
tests/pq/reset.sh --yes-this-is-a-disposable-database             # removes ONLY the PQ companies and their users
tests/pq/reset.sh --yes-this-is-a-disposable-database --recreate  # rebuilds the whole disposable database (scripts/test-backend.sh reset)
```

The default reset removes a company only when **all three** markers match: slug `t-<8 hex>-(jnr|practice)`, name
`Synthetic (JNR|Practice) PQ <same 8 hex>`, and its users `<role><n>.(jnr|practice).<same 8 hex>@example.test` (users left by a load that died
before its company existed are removed too). It removes every row of those companies from every table that has an `organization_id` column
(public and security_audit), the way `destroySyntheticWorld` does, then the users, then prints what is left over (nothing, or it exits 1).
Idempotent: a second run removes nothing. Anything else in the database is left alone (`pg-load.test.ts` plants decoys to prove it).

## What is seeded

Two companies, both clearly synthetic. All names, numbers and amounts are invented; every address ends `@example.test`.

**Synthetic JNR PQ** (`t-<run>-jnr`), the working company
- Users: 1 admin, 1+ office, 2+ workshop, 1 viewer (more office/workshop users as `--scale` rises).
- Customers (10 x scale plus a fixed awkward set): apostrophes, ampersands, accents, double spaces, quotes, a 140-character name, a one-letter name,
  a name that looks like SQL, an exact duplicate and two near-duplicates of one customer, one archived, one with no contact details.
- Parts (stock), 12 x scale, some below minimum level. Machines with hours per day and working days; one retired.
- Quotes (24 x scale) in every condition: draft, sent, sent-but-expired (the app has no "expired" status; it is `sent` with a `valid_until` in the past),
  accepted (becomes a sales order and a job through `accept_quote`), rejected. Some with VAT off, some lines VAT-exempt (not on accepted quotes, see limitations).
- Jobs: from accepted quotes (not started / in progress / complete), direct repeat jobs, internal jobs. Machine bookings (complete, running, planned).
- Completed jobs are inspected (`inspect_job`), delivered (delivery note, despatched, one in three signed), which drafts their invoice.
- Invoices (about 1.3 x quotes): draft, issued and current, issued and overdue, part paid (current and overdue), paid (some in two instalments), part-credited
  (credit note issued). Carriage with and without VAT. Payments by BACS, cheque, card, cash, other.
- Time sheets: 20 working days per scale step (up to 3) for every workshop and office user: in, break, break end, out; a late arrival now and then, an occasional shift with
  no clock-out. Labour sessions on in-progress jobs inside those shifts.

**Synthetic Practice PQ** (`t-<run>-practice`), the second company for the "company A then B" check (PQ-001): admin, office, viewer; three customers with **the same names** as JNR's
first three and quotes carrying **the same customer PO numbers**, so a leak between companies would show; its own invoices and a despatched job.

Money is whole pence throughout; line net = quantity x unit price, VAT per line rounded half-up (the database's own `check_document_totals` rule), total = net + carriage + VAT.
`verify.sh` re-derives these from the database rows and compares them with the generator's own figures.

### Dates

Every date and timestamp is the base date plus a whole number of days (`generate.test.ts` moves the base date by 28 days and checks every date moved by exactly 28 and nothing else
changed). Business dates only: `invoice_date`, `due_date`, `valid_until`, payment dates, booking starts, time events. Rows the database stamps itself (`created_at`, `updated_at`,
audit time, `inspected_at`) carry the **load time**. Moving the base date by a multiple of 7 days keeps the working-day pattern; other shifts change which days are weekends.

**Schedule and "now".** Migration 042 `booking_intervals` draws a booking that is started but not complete (status `running`, hours done below hours) from **now**, not from its start, so
it occupies the machine from the moment you look at the schedule. The generator therefore creates at most one running booking per machine, on or before the base date, with a remainder of
at most one working day, and plans everything else from the working day after the base date. If you load on a later day than the base date, the running booking's "from now" time can overlap the
first planned booking; `save_machine_booking` then refuses, and the loader books it as an **admin** with a recorded override reason (it prints `note: booking ... admin clash override`). That is normal
for a stale base date; for a clean schedule load with `--base-date` equal to today.

## How to run the PQ checks

1. **Database checks (automated):** `tests/pq/verify.sh --yes-this-is-a-disposable-database`. About 50 checks per run: row counts per table, quotes by status, invoiced / paid / credited / outstanding / overdue pence
   against the generator's figures, every invoice's lines add to its subtotal and subtotal + carriage + VAT = total, `amount_paid` = sum of payments, every quote total = lines + VAT, nothing paid or credited beyond
   its total, invoice numbers unique, no user in both companies. Exit 0 only if all pass.
2. **Generator and guard tests (no database):** `npx vitest run -c tests/pq/vitest.config.ts` (the `pg-load` file is skipped without `PQ_LOCAL_PG_URL`).
3. **Manual PQ steps (need the app and a browser; not run here).** Start the app against the local stack, load with `--auth api --base-date <today>`, and use `.env.pq.credentials`:
   - PQ-001 company A then B: sign in as JNR then Practice users; same customer names and PO numbers exist in both; try restricted actions as viewer, workshop, office.
   - PQ-002 quote to invoice: open a seeded quote, compare printed pence with `node tests/pq/seed/cli.mjs generate | jq` figures; follow an accepted quote to its job, delivery note and draft invoice.
   - PQ-003 shifts and job reopen: the seeded time sheets and labour give the week review and costing something to show.
   - PQ-004 / PQ-006 / PQ-007 / PQ-008 (accounting, AI, chasing, templates, caps) and PQ-009 (wipe and import rehearsal): the seed creates no integrations, connections, e-mail history or keys. They need their own setup.
   Record results in the PQ sheet; this README does not mark any step passed.

### Proving the database half without Docker

On any machine with PostgreSQL 16 binaries, a bare local server on loopback, and `psql` on `PATH`:

```sh
PQ_LOCAL_PG_URL=postgresql://postgres@127.0.0.1:55521/postgres npx vitest run -c tests/pq/vitest.config.ts tests/pq/pg-load.test.ts
```

It builds its own database from `supabase/migrations` on `support/local-pg-shim.sql`, loads, verifies, resets, runs the CLI end to end, and drops the database. `PQ_LOCAL_PG_URL` must itself be loopback.

## Known limitations

- Created/updated/audit timestamps are the load time, not backdated (the product writes them; the seeder does not bypass its triggers).
- Quotes are written with the product's rules, so an accepted quote with mixed VAT rates, or whose per-line VAT rounds differently from one rounding of the whole, is refused by `accept_quote`
  (`needs: sales_order_by_hand`). The generator avoids both on accepted quotes (no exempt lines, unit prices in whole 5p). Real JNR quotes with awkward pennies will hit this; the seed does not model "order entered by hand".
- No supplier purchase orders, RFQs, inbound e-mail, e-mail history, attachments, photos, rework, traceability certificates, chase rules, integrations or AI helper data.
- Time events are inserted as `clock` events by the service role (the clock-in RPC only takes "now"), so the network-lock and sync rules are not exercised.
- Signed delivery notes carry a synthetic receiver name; no signature image.
- `--auth sql` users cannot sign in; `--auth api` is unproven here.
- One organisation per kind per run id. The run id comes from the seed, so changing `--scale` or `--base-date` with the same seed reuses the id (reset first).

## Safety rules

1. Disposable only: every command needs `--yes-this-is-a-disposable-database` **and** `TEST_DATABASE_URL` (and `TEST_SUPABASE_URL`, if set) on `127.0.0.1`, `localhost` or `::1`. Hostnames that look hosted
   (`supabase.co`, `pooler.`, `vercel`, `amazonaws.com`, ...) and the two production project refs are refused anywhere in the value. The one extension is a Docker/CI service name, accepted only when `CI=true` and the exact
   name is listed in `PQ_DISPOSABLE_HOSTS`; nothing hosted-looking is ever accepted.
2. Identity before any write, including reset: `supabase_migrations` present, **no organisation whose slug is not `t-...`**, **no auth user outside `@example.test`**. A database that has ever held a real company or user is refused.
3. Never point this at a restore of real JNR data, at the JNREng project, or at a hosted project. Do not add real names, files, exports (SliQ or otherwise), keys or addresses to `tests/pq/`.
4. No provider calls: the loader makes no HTTP request except, with `--auth api`, to the local Auth admin API. No Supabase or Vercel hosted tool is used.
5. The seed never edits the guard in `tests/support/`, never disables an RLS policy, trigger or constraint, and never uses the service role to do what a user could do (except the listed plain inserts).

## How a later reviewer can verify no real data is present

- `node tests/pq/seed/cli.mjs generate --scale 3 | jq` and read it: it is the only source of data; there is no file, export or network read in `seed/` (`generate.test.ts` also fails if any seed source reads the clock or `Math.random`).
- `generate.test.ts` "nothing real-looking": every e-mail is `@example.test`, every phone is in an Ofcom drama range (01632 960, 020 7946 0, 0161 496 0, 07700 900), every postcode is `ZZ`, no URL, VAT number `GB 000 0000 00`,
  every customer's notes say `SYNTHETIC PQ DATA`, and no production project ref or JWT-shaped string appears.
- In a loaded database: `select email from auth.users` (all `@example.test`), `select slug, name from organizations` (only `t-<hex>-jnr|practice`, `Synthetic ... PQ <hex>`), and
  `select count(*) from customers where notes not like '%SYNTHETIC PQ DATA%'` (0). `pg-load.test.ts` asserts these.
- The pinned SHA-256 of the default dataset in `generate.test.ts` changes only when the generator does; a diff to it is a review point.
- Company names are invented word combinations; a coincidence with a real firm is unintended and would be the one thing a reader should still look for.
