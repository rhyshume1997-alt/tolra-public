# G06 — Missing before-counter check

This small follow-up fills the explicit pre-counter issuance case missing from #373. It does not repeat that PR's setter/double-run/concurrency/undo-after-use evidence or fix its two conditional custom-GUC findings.

Run `npx vitest run -c tests/reviews/g06-before-counter/vitest.config.ts`. The helper creates and identifies its own nonce-labelled, pinned-image PostgreSQL container, network none, no published ports; it accepts no database URL. Before SQL it checks container and database identity. All rows are synthetic. Original logs and commit/environment/SQL hash/UTC time/exit-code records remain under `/tmp/tolra-g06-hold-*`.

The private hold table and numbering guard are exact unchanged slices of public release 147 at `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`, read with `git show`. No candidate checkout, branch or #359 file is edited. The allocator is a sentinel that throws if reached: it does not simulate successful allocation. Both blank and typed number attempts must refuse with `dln_numbering_not_set` before reaching it. Both companies' note/hold snapshots must stay equal. A third check verifies another company's hold remains effective when only the fixture JNR hold is lifted.

This proves only that guard path. It does not install full 147 or prove final browser/RLS/audit/import behaviour. Reuse #373 for the real counter/undo scripts and the two unresolved conditional SQL-role bypass findings. No failure is relabelled as a pass. Final candidate acceptance: **NOT EXECUTED**.

Requirement G06; expected no pre-counter number and unchanged state; final actual ____ NOT EXECUTED; evidence reference ____; tester ____; date ____; approval ____.

Executed code `412fd82`, 5 November 2026 UTC, Codex: 3 passed, zero failed/skipped. Scoped lint passed. Identity receipts, SQL records and original Vitest output are retained in the evidence archive with its SHA-256. Later commit adds evidence only. Final release acceptance stays NOT EXECUTED; #373's two conditional findings remain open.
