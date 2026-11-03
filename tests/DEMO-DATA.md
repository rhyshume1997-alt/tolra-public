# Demo data for screenshots ("Tolra Demo")

A script that fills a **throwaway or local** database with a clearly fake company, so screenshots never show real customers. It is not part of any
migration, deploy or CI job, and it refuses to run against anything but this machine.

## Run it

1. Start the local disposable database (Docker needed): `scripts/test-backend.sh start` (writes `.env.test.local`).
2. Run: `node scripts/demo-seed/cli.mjs --yes-this-is-a-throwaway-database`
3. It prints the demo admin sign-in (`demo.admin@example.test`) and a one-time password. Start the app against the local stack to take screenshots.
4. To run it again, reset first: `scripts/test-backend.sh reset` (it refuses if "Tolra Demo" already exists).

## What it creates

Company "Tolra Demo"; customers Example Customer A, B and C; three jobs (DEMO-001 to DEMO-003); invoices that are paid, due and overdue; two machines with a
labour session and a machine run each (so the activity log has entries); everything with `@example.test` addresses and round example amounts.

## Safety

Refuses unless you pass `--yes-this-is-a-throwaway-database` **and** both the database and API addresses are `127.0.0.1`/`localhost`. Never put a hosted
connection string or key in `.env.test.local`. The unit test `tests/unit/demo-seed-plan.test.ts` checks these refusals and that the data is clearly fake.

## AF identity guard (review only, not run here)

A local address is no longer enough. The seed requires a fresh server-side `demo_seed_guard.identity` row and matching per-run `DEMO_DISPOSABLE_ID`. The marker binds the database name, expires after 15 minutes and is inaccessible to browser/service roles. The marker script refuses a nonempty database and cannot overwrite an existing marker. The seed checks the marker before creating an Auth user or company and refuses any company other than the exact Tolra Demo name/slug. Its original duplicate-demo refusal remains.

The manual **Demo seed rehearsal** workflow creates the empty disposable backend, generates the identity, runs `tests/demo-seed/mark-disposable.sql`, then runs the original seed command. No workflow was dispatched or SQL run in this change. A local operator must use that same reviewed marker preparation with a fresh UUID, retain the same UUID only in the process environment, and never mark a live/forwarded database as disposable. Reset rather than reuse an expired/used rehearsal. No production connection is supported. The seed never creates its own marker.
