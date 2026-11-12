# Tolra Demo screenshot records

This kit makes one clearly fake company, **Tolra Demo**, for screenshots. It is not an onboarding seed and never runs during sign-in, deployment or normal company creation. The writer has NOT been run on any database. Only its plan and fake-client tests were run.

It creates Example Customer A, B and C, three example jobs, two example machines, three closed machine-time records and three invoices: paid, due in seven days and overdue by fourteen days. All descriptions say FAKE SCREENSHOT DATA. Every amount is invented from integer pence (12,345p, 23,456p and 34,567p); none is a real price. The single fake payment agrees with the paid invoice. Normal audit triggers create the activity history, and the writer refuses to commit if none exists. Invoice wording remains Overdue; this does not change the separate Late wording for jobs.

All addresses use the reserved `example.test` domain. The owner is `demo-owner@example.test`, named Demo Owner. There are no real people, customers, keys, mailboxes or integrations. The company starts with unpaid breaks and integrations off. Existing companies are never copied or modified.

## What Code must prepare first

A database owner must separately prepare a fresh local test database named exactly `tolra_demo_throwaway`, using the reviewed Tolra schema and local Auth. This script does not create the database, install migrations or create Auth users. No production dump or real customer data may be used. The database must have **zero companies**.

Create a confirmed local Auth fixture for `demo-owner@example.test` with `full_name` exactly `Demo Owner`; keep its generated password outside this public repository and screenshots. Creating that login must not create a company. The seed then uses the existing `create_organization` function to give that fake login admin membership. Sign-in, MFA and company selection stay unchanged.

Use Node 22.18+ or Node 24 and `npm ci`. Set `DEMO_DATABASE_URL` privately to that database's postgres connection on `127.0.0.1`, `localhost` or `::1`. Never commit or paste the URL/password into evidence. Generic local `postgres` databases, hosted addresses, URL query overrides, non-postgres users and non-loopback database server addresses are refused. Docker/network addresses are deliberately refused rather than guessed safe: use a dedicated native-loopback test instance or keep the seed unrun.

## Look at the plan without a database

From repository root:

```sh
node --experimental-strip-types scripts/seed-tolra-demo.ts --plan
npx vitest run tests/unit/tolra-demo-seed.test.ts
```

The plan does not load the database driver or open a connection. The unit tests use a fake client; they prove guards, scoped statements and rollback handling, not real schema compatibility.

## Write only after the local database has been independently checked

These are operator instructions, not actions already performed:

```sh
node --experimental-strip-types scripts/seed-tolra-demo.ts --write --confirm 'SEED TOLRA DEMO LOCAL ONLY'
```

Both the connection URL and the database's own name/address/role are checked. The writer takes a lock, refuses any existing company, and then writes one transaction. Any error rolls back all seed records. It never disables guards, sends messages, connects integrations, applies SQL migrations or erases a company. Repeating it refuses; it does not overwrite the first run.

Sign in through the existing login page as Demo Owner and choose Tolra Demo if asked. Verify all three customer names, paid/due/overdue invoice cases, machine times and Activity. Check totals and payment history agree before taking screenshots. Capture no login/password/key screens. Mark pictures “Demo data” if their context could be mistaken for real work.

Afterwards discard the entire independently verified local throwaway database using the test environment's normal cleanup procedure. There is intentionally no broad delete/reset command in this kit. No real database runtime or screenshot/browser check has been performed here; keep those checks NOT RUN until Code prepares and tests the disposable instance.
