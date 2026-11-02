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
