# John demo: start again safely

PRELIMINARY. Fake data only. No human result or approval is recorded here.

Read first: Code's [draft #450](https://github.com/rhyshume1997-alt/tolra-public/pull/450), `claude/docs-john-demo-script` at `b89471abd664edec3dc4b3f5d58e89ea75585e63`, file `docs/demo/JOHN-CLICK-BY-CLICK-DEMO-SCRIPT.md`. That draft describes two different unexecuted seeds. This supplement selects **one tested environment**: [#455](https://github.com/rhyshume1997-alt/tolra-public/pull/455), SHA `2dd86eb7ec02d94c238e8af815d090bb5692b14c`. Do not mix those older seeds, names or accounts with this fixture. Code's draft is unchanged.

Its start, screenshots, reset, reseed and reuse were executed in [run 42222887736](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/42222887736). That evidence proves the selected source SHA only, not John's device or the final candidate.

## Start

Rhys or Code uses a separate disposable checkout of that SHA, with Node 22, Docker running, Supabase CLI 2.40.7, about 15 GB free disk, and ports 3007 and 55320–55324 free. Never use the production checkout or a linked database.

```sh
npm ci
node tests/pq/pq.mjs start
```

Keep the terminal open. Open Chrome at **http://localhost:3007**. The command starts its own `tolra-pq-synthetic` project, verifies releases through 151, loads fake records and builds the real app against that local backend. AI, Xero and email providers stay off/unconfigured. App `.env` files are refused; the built-in demo-mode flag is not inherited. Nothing is deployed.

Read `tests/pq/.runtime/accounts.json` locally. Use `world.tenants.alpha.users.admin` or `.workshop`. Passwords are freshly generated. Never share that file or photograph passwords/codes. Admin MFA stays on; get its local practice code in a second terminal:

```sh
node tests/pq/pq.mjs code
```

After first setup, wait for the next 30-second code window. Never enter a real user's code.

## Reset before a new demo

1. Stop the app with **Ctrl+C**. Close its Chrome tabs. Confirm the terminal is in the separate demo checkout.
2. Erase and reload only this fake project:

   ```sh
   node tests/pq/pq.mjs reset
   ```

3. Wait for success, then start the app:

   ```sh
   node tests/pq/pq.mjs start
   ```

4. Open a new Chrome Guest window. Read the **new** account file and get a **new** code. Reset changes accounts, passwords and MFA secrets; old sessions must not be reused.
5. Check the company is **FAKE JNR Engineering PQ**. QUO-PQ-0001 and INV-PQ-0001 should be drafts; DLN-PQ-0001 should be pending; the synthetic approval email should still be a draft. These are expected fixture states, to be checked on the day.
6. Stop on a wrong company, missing record, error or changed amount. Save the source SHA and error without credentials. Do not repair rows, configure providers or use a real company to get past a failure.

Reset checks project ownership, unlinked status and exact loopback endpoints before deletion. Do not replace it with manual SQL or a remote reset command. If image download fails before startup, fix local disk/network capacity and retry start. If loading failed after the stack started, reset before retrying.

## Finish

Stop the app with Ctrl+C, then delete its disposable project:

```sh
node tests/pq/pq.mjs stop
```

Screenshots remain in `tests/pq/screenshots/`; keep only fake-data pictures without credentials. Follow [JOHN-FAKE-PQ-CLICKS.md](JOHN-FAKE-PQ-CLICKS.md). This procedure does not load production data or prove live connections.

Prepared by: __________  Date: __________  Checked by: __________  Approval: __________
