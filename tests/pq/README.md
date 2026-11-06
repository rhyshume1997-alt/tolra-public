# Disposable synthetic JNR PQ

This is an invented practice company, **FAKE JNR Engineering PQ**. No JNR customer or production data is used. It is not a completed PQ, sign-off or permission to go live. Leave the human results and signatures blank until someone performs the checks.

Use a separate checkout of this branch. Requirements: Node 22, npm, Docker Engine/Desktop running, Supabase CLI **2.40.7**, about **15 GB free disk** and **8 GB RAM** recommended. Ports 55320–55324 and 3007 must be free. The CLI install and published checksums are in `.github/workflows/ci.yml`; do not use a newer CLI as a substitute.

```sh
npm ci
node tests/pq/pq.mjs start
```

Keep that terminal open. Open Chrome at **http://localhost:3007**. Accounts and generated passwords are in `tests/pq/.runtime/accounts.json`: use `world.tenants.alpha.users.admin` or `.workshop`. These are disposable accounts, not anyone's real login. The administrator must pass real local MFA. For its current code, use another terminal:

```sh
node tests/pq/pq.mjs code
```

After initial setup, wait until the next 30-second code window before signing in. Do not publish the account file or screenshots of passwords/codes. Workshop sign-in has no admin privileges. A second synthetic company is present for isolation practice.

First startup estimate: **10–20 minutes**, including Docker image downloads, dependencies and a production app build. With images/dependencies cached, expect **2–5 minutes**. Every app start rebuilds against this local backend; it never reuses a possibly hosted build. These are estimates, not a timing guarantee; see the PR for the measured Actions run. No paid service is required locally. This executor cannot hold the full images, so its local Docker run is blocked by disk capacity; real stack proof runs on a disposable Actions runner.

## What startup does

Creates an isolated `tolra-pq-synthetic` project under the ignored `.runtime/` directory, with its own ports. Copies the branch's numbered migrations through 144 unchanged, then installs and verifies existing one-time releases **145, 146, 147, 148, 149, 150, 151** in order. This is a test application of the 151 proposal; it does not register it or change applied migration history. Every verifier row must pass. Creates users through local Auth and a complete fake company profile, loads linked synthetic business rows, and checks actual costs via the existing RPC.

The fixture contains two customers, two stock parts (`FAKE-PART-BRACKET`, `FAKE-PART-SPACER`), two shop machines, one material/machine rate set from 143, one draft quote, one linked customer PO/order, two jobs (one with time/cost inputs and one missing them), one **pending** delivery, one **draft** invoice and one **drafted** approval email. No inspection, dispatch, customer signature or human approval is invented. Quote/order/job links are practice fixtures, not evidence the conversion flow ran. Stock parts are represented in the existing stock table and document lines; there is no new parts subsystem.

Invoice: £125.00 net + £25.00 VAT = **£150.00**. One hour's labour costs 2,000p, with 1,000p overhead; machines are explicitly not required for that job. Rates are synthetic, not JNR's actual rates. Base 9b63382e retains the pre-#446 rounding implementation: this environment does not silently include #454. Do not use its half-penny results as evidence for #454.

AI is OFF, no keys are loaded, there are no Xero connections/sends, and no mail provider credentials are inherited. The Node server uses the existing loopback network guard. It refuses root app `.env` files to prevent Next loading real credentials. Do not add credentials, connect providers, expose Docker ports or send real email. Local Auth email goes only to the local mail catcher at http://127.0.0.1:55324. Provider send/consent is outside this run sheet.

## Stop, restart and erase

Stop the app first with **Ctrl+C**. This leaves the fake database in place. Restart it with `node tests/pq/pq.mjs start`. The existing account file is reused; it does not load duplicates.

To erase this PQ project and rebuild the fake data (destructive to this project's practice work only):

```sh
node tests/pq/pq.mjs reset
node tests/pq/pq.mjs start
```

To stop and delete only this PQ project's containers, volumes and local accounts:

```sh
node tests/pq/pq.mjs stop
```

The script checks the owned project, refuses linked projects and requires the exact loopback database/API before any reset. It does not use `supabase link`, `db push`, a remote database or the repo's ordinary test-stack project. Do not manually point it at another stack. If startup fails before accounts are written, stop the app and use reset; startup refuses a partly seeded database. Screenshot files remain under `tests/pq/screenshots/`; delete these yourself if wanted.

## Repeatable screenshot proof

```sh
node tests/pq/pq.mjs prepare
npx playwright install chromium
npx playwright test -c tests/pq/playwright.config.ts
```

This opens actual pages against the real local Supabase and saves screenshots. It fails if the backend, fixture or pages are missing; it is a navigation/data smoke test, not completed human acceptance. It starts its own app, so stop an existing app on port 3007 first. See [RUN-SHEET.md](RUN-SHEET.md) for human clicks and blank results.

## Can this have a free hosted preview URL?

Local Docker and Chrome need no hosting payment. A public-repository Actions run can produce downloadable screenshots without purchasing hosting, subject to GitHub's account limits. **Actions is not a persistent preview URL**. A hosted app plus database may fit providers' free tiers if Rhys has eligible accounts and available quota, but no account, quota or free entitlement has been confirmed here. This script intentionally refuses hosted databases. Publishing a preview would need a separately approved setup, synthetic data and access controls; nothing is deployed by this branch.
