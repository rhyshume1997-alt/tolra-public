# Tolra work ownership

Coordination record introduced by Codex on 2 November 2026 under the master build request. No tracker existed on public main a546c3a or private main 9e56680. Existing branches and PRs are preserved; their presence does not establish a transferable claim. Do not take over another builder's implementation without a recorded handoff.

Publish a claim by creating `refs/heads/claims/<existing-job-code>` atomically through GitHub, then update this table on a dedicated branch. An existing claim ref must never be overwritten. Check this file, open PRs and remote branches again before each claim. Never invent a job code.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| A8 | Claude / ChatGPT; implementation retained with original builders | claude/a8-costing-activation; claude/costing-in-app; chatgpt/costing-in-tolra; chatgpt/costing-wiring | IN PROGRESS | #110, #121, #123 |
| A10 | Claude; existing CI work | claude/tolra-a10-ci-shard | IN PROGRESS | #11 |
| G9 | Claude; existing SliQ importer; ChatGPT builders own additional parser tests | claude/sliq-import; chatgpt2/sliq-importer-tests; chatgpt/sliq-risk-tests | IN PROGRESS | #114, #122 |
| E13 | Claude; existing timesheet scheduling work | claude/e13-timesheet-days | IN PROGRESS | — |
| — (coordination and read-only verification requested in master build prompt; no new job code) | Codex | codex/work-ownership | CLAIMED | — |

## Existing work without a verified original job-code mapping

Treat these as occupied, not AVAILABLE: #107/#117 payment-claim detection and adapter; #108/#118/#119 invoice chase engine/wording/tests; #109/#116/#120 bank reconciliation helpers/UI/tests; #111 settings, #112 approval card, #113 customer-payment-claim UI; #115 staff guide; #124 builder handover; #125 wipe guide. Claude also has `claude/chase-steps`. Do not duplicate these implementations.

## Blockers

- The public repository omits the original operating protocol/master plan by design (`CLAUDE.md`). Private `Tolra Progress.md` and the handover branch describe an older queue; a complete current mapping of A/B/C/D/E/G/L jobs to availability was not found. Unverified codes cannot safely be claimed.
- No original builder has recorded a handoff of the occupied work above. Confirm ownership before changing those branches or integrating their code.
- Go-live approvals, production changes, merges and deployments remain outside this build's authority.

Rhys authorised Codex follow-up fixes on separate branches in this session. Original branches remain untouched.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| — (bank reconciliation #109; original code unavailable) | Codex | codex/bank-csv-quotes; atomic claim claims/pr109-csv-quotes | DONE IN PR | #131 (local checks pass; CI pending) |

## Builder 2 master queue (Rhys, 2 November 2026)

The numbered jobs below are explicitly assigned to builder2. Changes stay on builder2 branches. No handoff of other builders’ source branches is implied.

| Job | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| 6 | builder2 | chatgpt2/chase-wiring | DONE WITH INTEGRATION GAPS | #132 |
| 7 | builder2 | chatgpt2/go-live-day-checklist | DONE IN DRAFT PR | #133 |
| 8 | builder2 | chatgpt2/e2e-chasing | DONE IN DRAFT PR | #134 |
| 9 | builder2 | chatgpt2/pr-review | REVIEW COMPLETE; FOLLOW-UP GAPS RECORDED | #135 |
| 10 | builder2 | chatgpt2/bank-csv-formats | DONE IN DRAFT PR | #136 |
| 11 | builder2 | chatgpt2/paid-claim-more-tests | DONE IN DRAFT PR | #137 |
| 12 | builder2 | chatgpt2/receivables-tests | DONE IN DRAFT PR | #138 |
| 13 | builder2 | chatgpt2/plain-english-pass | DONE IN DRAFT PR | #139 |
| 14 | builder2 | chatgpt2/costing-playwright | DONE IN DRAFT PR | Pending |
