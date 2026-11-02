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
# Tolra work ownership

Who owns each piece of work. Read this before claiming anything. Add a row for your own work; never take a row someone else owns.

House rules for every builder (Claude Code, ChatGPT builders, Codex):
- Merges to main, migration numbers, and applying migrations to production are done by Claude Code only, after a reviewer SAFE verdict and a green ci-gate.
- Nobody deploys, and nobody commits directly to main.
- A builder adds the `Ready` label only to its own PRs, and only when its own checks pass.
- Migration numbers in use or reserved: 136, 137 (live); 138 chasing; 140, 141 SliQ; 142 timesheet emails; 143 costing. Ask Claude Code before taking a new number.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| G1 admin recent code + password tickets (136, 137) | Claude Code | claude/g1-logos-mfa-redirects | Done: merged, live in production 2 Nov | #106 |
| CHASE-P1 chase steps, drafts, approve and send, pause (138) | Claude Code | claude/chase-steps | Built; waiting on review verdict, then PR | - |
| CHASE-P2 "customer says paid" database side (in 138) | Claude Code | claude/chase-steps | Built inside 138 | - |
| CHASE-P2/P3 screens and wiring (inbox, approvals, bank check page) | ChatGPT builders, joined by Claude Code | chatgpt/*, chatgpt2/* (PRs into claude/chase-steps where they need 138) | In progress | #111-#113, #116, #117 |
| E13 timesheet emails on chosen days (142) | Claude Code | claude/e13-timesheet-days | Built; waiting on review verdict, then PR | - |
| SLIQ importer (140, 141) | Claude Code | claude/sliq-import | Built; waiting on review verdict and John's export headers | - |
| COSTING in Tolra: tables, rates code, golden answers (143) | Claude Code | claude/costing-in-app | Built | - |
| COSTING maths and screens | ChatGPT builder 1, joined by Claude Code | chatgpt/costing-in-tolra, chatgpt/costing-wiring | In review | #110, #123 |
| WIPE kit for JNR test data | Claude Code (private docs) | not in this repo | Built; waiting on review verdict | - |

## Codex master queue dispositions

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| paid-claim-wiring | Existing CHASE-P2/P3 owners retained | claude/chase-steps | BLOCKED | #117 |
| bank-check-wiring | Existing CHASE-P2/P3 owners retained | chatgpt/bank-check-ui | BLOCKED | #116 |
| chase-ui-wiring | Existing CHASE-P2/P3 owners retained | chatgpt2/* | BLOCKED | #111–#113 |
| e13-tests | Existing E13 owner retained | claude/e13-timesheet-days | BLOCKED | — |
| sliq-import-tests | Existing SLIQ owner retained | claude/sliq-import | BLOCKED | — |
| costing-check | Existing COSTING owners retained | chatgpt/costing-in-tolra; chatgpt/costing-wiring | BLOCKED | #110, #123 |
| full-suite | Codex (own branch only) | codex/bank-csv-quotes | IN PROGRESS | #131 |
