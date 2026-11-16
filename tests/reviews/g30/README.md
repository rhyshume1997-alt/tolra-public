# G30 — AI request rows: count, company and identity

## Scope

This PR delivers only a reusable read-only snapshot, an offline checker and synthetic tests. **Real scenario B comparison: unverified here, owned by Code.** Its private evidence, report and wipe-kit files remain in the private repository and are not inputs to this PR or public CI. No private wipe source or scenario evidence is included or executed.

The 41-row example below is made-up test data, not scenario B's records. Choose WIPE or KEEP from the run owner's approved private decision; the checker does not infer that decision from a count or label. A 0-versus-41 count alone cannot establish ownership or record identity. Code owns the actual comparison and explanation.

## Reusable check for any authorised run

First verify the run's target identity and exact kit/SHA. For this work, only newly created disposable databases with synthetic records are authorised. `snapshot.sql` is read-only and captures **all companies**: counts, record UUID, company UUID and a hash of the complete row. It emits no request text, model response or key. UTC avoids timezone-only hash changes. It refuses a filtered RLS read instead of silently missing other companies; it does not bypass RLS permissions.

Capture before and after, using that run's authorised connection:

```
psql -X -v ON_ERROR_STOP=1 -d "$DISPOSABLE_DB" -f tests/reviews/g30/snapshot.sql > before.json
# Approved rehearsal action belongs to the run, not this checker.
psql -X -v ON_ERROR_STOP=1 -d "$DISPOSABLE_DB" -f tests/reviews/g30/snapshot.sql > after.json
node tests/reviews/g30/compare.mjs before.json after.json --jnr COMPANY_UUID --disposition WIPE --expected-jnr-before 41 > differences.json
```

Choose the UUID from the independently checked company record. Choose WIPE/KEEP from the approved exact kit; 41 is optional and belongs only to a run with that baseline. The comparator is offline and accepts no DB URL. Exit 0 means the supplied snapshots match that policy, 1 means a violation, 2 means invalid/missing evidence. It checks counts against every supplied row identity, rejects duplicates, checks all other companies unchanged and outputs **every** added/removed/moved/changed row, including expected JNR removals. No list truncation. Separate company counts show expected and actual after-counts. Same counts cannot hide replacement IDs. Output hashes bind the exact input files; hashes alone do not prove truthful capture or approve a wipe.

## Synthetic verification

Run `npx vitest run -c tests/reviews/g30/vitest.config.ts`. Docker and the cached pinned PostgreSQL image are required. The test creates its own nonce-labelled, network-isolated container, checks image/ID/label/no ports/database before SQL, accepts no DB URL and removes its own container. The public 101 request-table definition is used; all 82 records are synthetic, 41 per company. Actual private wipe SQL is never run. Test-only deletes/updates deliberately simulate both correct and wrong outcomes.

Nine cases cover complete capture, every expected JNR removal, every wrong-company removal, owner move, replacement IDs, changed content, malformed/duplicate/count evidence, filtered-capture refusal and CLI exit/list completeness. Original logs, SQL hashes, source/commit/environment/UTC/exits, identity receipts and synthetic before/after/difference manifests are retained in the evidence archive.

Real scenario B comparison: **unverified here, owned by Code**. Operational record template: requirement G30; expected the approved per-company policy and all other identities/hashes unchanged; actual ____ **NOT EXECUTED**; evidence ____; tester ____; date ____; approval ____.

Executed code `d3c4d76`, 5 November 2026 UTC, Codex: **9 passed, zero failed/skipped**. Lint and TypeScript passed. `evidence/synthetic-run.tar.gz` contains only synthetic snapshots/differences, original test output and SQL/identity receipts; `archive.json` records its SHA-256. This later commit attaches synthetic evidence only. Real scenario B comparison: **unverified here, owned by Code**.
