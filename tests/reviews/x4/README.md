# X4 — Synthetic Marpet isolation checks

Run from the repository root:

```
npx vitest run -c tests/reviews/x4/vitest.config.ts
```

The suite creates its own random-name, nonce-labelled PostgreSQL container from a pinned image. It accepts no database URL or credential. It verifies container ID, label, image, network isolation, absence of published ports and database identity before SQL. Data is synthetic. Every statement has commit, environment, UTC time, SQL hash, exit code and original log hash under `/tmp/tolra-x4-*`. Cleanup checks container identity before removing only its own container.

Scope: 16 minimal business tables, main's actual 006 RBAC policy block, main's actual 121 membership resolver and 036 helpers. Supporting tables and Auth JWT functions are synthetic. The private hold table definition/grants are an unchanged slice from public release 147 at `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`, read with `git show`; no candidate branch is edited. Tests include SELECT/UPDATE/DELETE refusal, moving a JNR row to Marpet, a forged company selection and denied access to `dln_numbering_pending`.

The fixture-only JNR purge removes JNR rows using explicit company predicates and keeps both numbering holds. A bad global delete must fail a Marpet-preservation assertion and roll back. These test the fixture boundary, **not the final JNR wipe kit**. A database owner can bypass RLS; an actual owner-run wipe needs its own exact source and before/after evidence.

## Finding X4-01 — actual wipe proof is missing

No approved, public JNR wipe SQL was found in main or the pinned delivery-note tree. Do not substitute the fixture purge for it. Actual JNR wipe execution: **NOT EXECUTED**. Complete app schema/RLS, storage files, Auth, audit chain, final combined release and real Marpet preservation are not established by this suite. #373 records the related limitation; no private wipe source was copied or run publicly.

Before closing X4, supply the approved exact wipe artifact and hash. On a separately created synthetic/restored disposable target, prove the complete KEEP list includes `dln_numbering_pending`, all Marpet rows/files/counters/holds are unchanged, JNR KEEP records remain, only agreed JNR WIPE records change, and a failed run rolls back. Do not use production data to fill this public test pack.

Acceptance record: requirement X4; expected complete tenant and wipe isolation; actual ____ **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval ____.
