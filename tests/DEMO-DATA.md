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
