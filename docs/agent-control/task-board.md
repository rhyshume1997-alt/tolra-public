# Current task board

Statuses: DONE, IN PROGRESS, BLOCKED, NOT STARTED, SUPERSEDED. DONE always has a qualifier: coded, merged, deployed or verified in production. An open draft is not merged. Read decisions first. No new master plan is created.

| Task ID | Objective | Agent | Files | Acceptance criteria | Tests | Branch or PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Reuse/control current public facts and decisions | Codex | AGENTS.md; CLAUDE.md; docs/agent-control/{current-state,decisions,task-board,handover,release-gates}.md | Guidance retained; owners, default-off policy, gates explicit | agent-control document checks | codex/agent-control-reconcile | DONE (coded); review/merge pending |
| B | Reconcile existing main/PR feature state | Codex | docs/agent-control/feature-reconciliation.md | Paths, PRs, tests and unknowns; no full audit | Targeted source + 217 passed, 0 skipped | #394 | DONE (coded); review/merge pending |
| C | Verify AI implementation; smallest provider fix only if placeholder | Codex | Existing lib/ai-helper; tests; AI verification note | Real adapter/wiring demonstrated with mocks; cap not bypassed; OFF | 190 passed, 0 skipped; real SDK mocked | #395 | DONE (coded); live checks unproven |
| D | Finish existing Xero gaps with mocks | Codex | Existing lib/integrations/xero; tests; verification note | OAuth through reconciliation/admin checks; OFF default | 233 passed, 0 skipped; tsc/lint pass | #396 | DONE (coded); review/merge pending |
| E | Assess Cloudflare skills | Codex | Three-line public README assessment | Relevant skills named, yes/no; nothing installed/moved | README read; 0 run, 0 skipped | #397 | DONE (coded); no install |
| F | Hand off all earlier Codex PRs for review | Codex | docs/agent-control/review-handoff-template.md; review packets | Each packet has evidence/limits; AWAITING CHATGPT REVIEW | Packet inventory checks pending | codex/chatgpt-review-handoff-records | IN PROGRESS |
| DEV-001 | Implement alert plus message | Claude Code | Held-company UI/server wiring; #390 tests | User understands hold; entered work retained; safe signal | #390: 2 pass, 4 fail, 0 skip | #390 pickup; #359 owned and untouched | IN PROGRESS (tests coded, implementation pending) |
| CHATGPT-REVIEW | Independently review each draft | ChatGPT review | PR diff and packet | Findings tied to evidence; SAFE only where proved | Reviewer chooses focused checks | Individual draft PRs | NOT STARTED |

Existing Claude Code ownership stays: release/cutover implementation and #359, G03/G05/G14/G15/G17/G21/G23/G24/G26 tests. Codex owns only the assigned reconciliation/fixes on separate branches. Rhys owns GO/NO-GO and live authorisation. This table does not transfer occupied implementation work.
