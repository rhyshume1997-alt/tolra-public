# G33 — Release 147 and the synthetic import path

Source: public candidate `9d7725e7e1b59e68a314c4148513b9b7d7aa4e92`, read with `git show`; no candidate branch or #359 is edited. The app mapping/build modules on main are identical at that candidate. Preprocessing reuses the public synthetic rehearsal copy from #368, not private source. It supports report-shaped invoices/payments; canonical credit/delivery sheets and the remaining original safeupdate record kinds are explicit synthetic supplements. No private code, real data, provider call or production credential is used.

## Run

```
git fetch origin 9d7725e7e1b59e68a314c4148513b9b7d7aa4e92
bash tests/reviews/g33/prepare-safeupdate.sh /tmp/g33-extension-build
G33_SAFEUPDATE_SO=/tmp/g33-extension-build/safeupdate.so npx vitest run -c tests/reviews/g33/vitest.config.ts
```

Needs Docker, GCC, dpkg-deb and curl. Header package and genuine pg-safeupdate source are version/hash pinned; the compiled library hash is recorded. Missing library/failed LOAD is a **failure**, never a skip or fallback. Preparation downloads public dependencies only. The test creates its own nonce-labelled, pinned-image PostgreSQL container, network none, no published ports, and verifies container/database identity before every SQL call. It accepts no DB URL and removes only that container.

All complete numbered migrations from 000 through 144 run unchanged in order, including **138 → 140 → 141 → 144**; complete one-time releases **145 → 146 → 147** follow. Release 147 verification must return at least ten rows, all true. Auth/Storage prerequisites are test-only minimal schema/JWT functions; this proves the SQL path, not running Auth/Storage/PostgREST services or browser behaviour. No application guard or trigger is removed or relaxed.

## Five ungated replacements

[CI 41936446385](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41936446385), integration job 126946024011, reports 1702 passed / 7 skipped. Five skips are direct-session safeupdate cases, now covered without `runIf` in this suite:

| Original case | New case |
| --- | --- |
| `data-import-safeupdate.test.ts`: unqualified UPDATE/DELETE refusal, including inside a function | G33-SU1 |
| Same file: small dry run, commit, counts and repeat match | G33-SU2 |
| Same file: one bad row refuses the whole small file | G33-SU3 |
| Same file: stage, validate, commit parts and undo | G33-SU4 |
| `data-import-pr2.test.ts`: small/large credit and delivery notes, then undo | G33-SU5 |

The original files/gates remain untouched. These new direct-session cases load real safeupdate before authenticated SQL calls. They retain all original import record kinds; invoice/payment reports also use the public preprocessor and actual page mapper. The two optional `IMPORT_TIMING` cases remain outside this replacement; no production-scale timing is claimed.

Other checks prove the ordered install, paused-company refusal and 147 hold behaviour. A DLN numbering hold is **not** a whole-company pause: 147 deliberately permits same-company historical imports under its import guard while preventing newly issued manual notes. Both companies' hold rows/timestamps and Marpet business snapshots remain identical. Successful historical delivery-note import exercises the live 147 triggers without disabling them.

Reconciliation: two invoices total 144.06; one linked payment 60.00; one credit 12.00; balance 72.06. Re-import creates no duplicate business records. Dry-run and bad-row snapshots cover business, counters, holds and import record keys. The importer intentionally retains batch/audit attempt bookkeeping; this is not a claim of zero writes to every table. Multipart undo restores the compared business snapshot. Counts are tested alongside record links and values.

Commit/environment/SQL hash/UTC time/exit code and original logs are retained under `/tmp/tolra-g33-*`, then archived in `evidence/`. Full Supabase-image unpack failed for disk space and an initial library mode of 0700 prevented loading; both original failures are retained. Fixing only the public library's file mode did not change a security expectation. Final release acceptance/approval: **NOT EXECUTED**; requirement G33, expected unchanged guarded import/reconciliation, actual ____; evidence ____; tester ____; date ____; approval ____.

Executed code `84c3920`, 5 November 2026 UTC, Codex: **8 passed, zero failed/skipped**, including all five ungated replacements. Scoped lint and TypeScript passed. `evidence/archive.json` hashes the archive and extension dependencies; the archive retains committed-run SQL/identity records and original earlier setup failures. Later commit attaches evidence only. No running test container remains. Approval is still blank/NOT EXECUTED.
