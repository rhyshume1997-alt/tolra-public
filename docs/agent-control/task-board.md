# Current task board

Statuses: DONE, IN PROGRESS, BLOCKED, NOT STARTED, SUPERSEDED. DONE always has a qualifier: coded, merged, deployed or verified in production. An open draft is not merged. Read decisions first. No new master plan is created.

| Task ID | Objective | Agent | Files | Acceptance criteria | Tests | Branch or PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Reuse/control current public facts and decisions | Codex | AGENTS.md; CLAUDE.md; docs/agent-control/{current-state,decisions,task-board,handover,release-gates}.md | Guidance retained; owners, default-off policy, gates explicit | agent-control document checks | codex/agent-control-reconcile | DONE (coded); review/merge pending |
| B | Reconcile existing main/PR feature state | Codex | docs/agent-control/feature-reconciliation.md | Paths, PRs, tests and unknowns; no full audit | Targeted source + 217 passed, 0 skipped | #394 | DONE (coded); review/merge pending |
| C | Verify AI implementation; smallest provider fix only if placeholder | Codex | Existing lib/ai-helper; tests; AI verification note | Real adapter/wiring demonstrated with mocks; cap not bypassed; OFF | 190 passed, 0 skipped; real SDK mocked | #395 | DONE (coded); live checks unproven |
| D | Finish existing Xero gaps with mocks | Codex | Existing lib/integrations/xero; tests; verification note | OAuth through reconciliation/admin checks; OFF default | 233 passed, 0 skipped; tsc/lint pass | #396 | DONE (coded); review/merge pending |
| E | Assess Cloudflare skills | Codex | Three-line public README assessment | Relevant skills named, yes/no; nothing installed/moved | README read; 0 run, 0 skipped | #397 | DONE (coded); no install |
| F | Hand off all earlier Codex PRs for review | Codex | docs/agent-control/review-handoff-template.md; review packets | Each packet has evidence/limits; AWAITING CHATGPT REVIEW | 4 offline checks passed, 0 skipped; original PR tests not re-run | #398 | DONE (coded); AWAITING CHATGPT REVIEW |
| DEV-001 | Implement alert plus message | Claude Code | Held-company UI/server wiring; #390 tests | User understands hold; entered work retained; safe signal | #390: 2 pass, 4 fail, 0 skip | #390 pickup; #359 owned and untouched | IN PROGRESS (tests coded, implementation pending) |
| CHATGPT-REVIEW | Independently review each draft | ChatGPT review | PR diff and packet | Findings tied to evidence; SAFE only where proved | Reviewer chooses focused checks | Individual draft PRs | NOT STARTED |

Existing Claude Code ownership stays: release/cutover implementation and #359, G03/G05/G14/G15/G17/G21/G23/G24/G26 tests. Codex owns only the assigned reconciliation/fixes on separate branches. Rhys owns GO/NO-GO and live authorisation. This table does not transfer occupied implementation work.

## Reconciled evidence PRs #385–#398

Public review snapshot: [review-status-385-398.json](review-status-385-398.json). No submitted GitHub reviews were found for these 14 PRs; the observed comments are Vercel deployment notices, not ChatGPT verdicts. Each remains **AWAITING CHATGPT REVIEW** under #398. No claim is made about a review outside the available record. All were open drafts at observation; NONE is marked merged, deployed or production-verified. Counts below are historical originating runs, not re-runs in this document update (passed / failed / skipped).

| Task ID | Objective | Agent | Files | Acceptance criteria | Tests | Branch or PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REC-385 | G33 release147 import rehearsal | Codex; ChatGPT review | tests/reviews/g33 | Exact-head independent review; retain limits and original logs | 8 / 0 / 0 | [#385](https://github.com/rhyshume1997-alt/tolra-public/pull/385) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-386 | G30 reusable wipe checker | Codex; ChatGPT review | tests/reviews/g30 | Exact-head independent review; retain limits and original logs | 9 / 0 / 0 | [#386](https://github.com/rhyshume1997-alt/tolra-public/pull/386) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-387 | G31 provided AI cap | Codex; ChatGPT review | tests/reviews/g31 | Exact-head independent review; retain limits and original logs | 6 / 0 / 0 | [#387](https://github.com/rhyshume1997-alt/tolra-public/pull/387) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-388 | G32 cutover order patches | Codex; ChatGPT review | docs/audit/G32-CUTOVER-ORDER-REVIEW.md | Exact-head independent review; retain limits and original logs | 3 / 0 / 0 | [#388](https://github.com/rhyshume1997-alt/tolra-public/pull/388) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-389 | Release147 numbering and holds | Codex; ChatGPT review | tests/reviews/release147 | Exact-head independent review; retain limits and original logs | 7 / 0 / 0 | [#389](https://github.com/rhyshume1997-alt/tolra-public/pull/389) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-390 | DEV001 red alert contracts | Codex; ChatGPT review | tests/reviews/dev001 | Exact-head independent review; retain limits and original logs | 2 / 4 / 0 | [#390](https://github.com/rhyshume1997-alt/tolra-public/pull/390) | DONE (coded); AWAITING CHATGPT REVIEW; feature implementation pending |
| REC-391 | Actual profitability independent review | Codex; ChatGPT review | tests/reviews/profitability | Exact-head independent review; retain limits and original logs | 34 / 2 / 0 (historical pinned fixture) | [#391](https://github.com/rhyshume1997-alt/tolra-public/pull/391) | DONE (coded); AWAITING CHATGPT REVIEW; findings fixed in #378 fa5e358, review pending |
| REC-392 | ISO pack blank supplements | Codex; ChatGPT review | docs/iso9001/review-supplements | Exact-head independent review; retain limits and original logs | 3 / 0 / 0 | [#392](https://github.com/rhyshume1997-alt/tolra-public/pull/392) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-393 | Agent control records | Codex; ChatGPT review | AGENTS.md; CLAUDE.md; docs/agent-control | Exact-head independent review; retain limits and original logs | 3 / 0 / 0 (prior control run) | [#393](https://github.com/rhyshume1997-alt/tolra-public/pull/393) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-394 | Feature reconciliation | Codex; ChatGPT review | docs/agent-control/feature-reconciliation.md | Exact-head independent review; retain limits and original logs | 217 / 0 / 0 | [#394](https://github.com/rhyshume1997-alt/tolra-public/pull/394) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-395 | Existing AI provider verification | Codex; ChatGPT review | docs/agent-control/ai-existing-provider-verification.md | Exact-head independent review; retain limits and original logs | 190 / 0 / 0 | [#395](https://github.com/rhyshume1997-alt/tolra-public/pull/395) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-396 | Xero read-back safety | Codex; ChatGPT review | lib/integrations/xero/client.ts | Exact-head independent review; retain limits and original logs | 233 / 0 / 0 | [#396](https://github.com/rhyshume1997-alt/tolra-public/pull/396) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-397 | Cloudflare skills assessment | Codex; ChatGPT review | docs/agent-control/cloudflare-skills-assessment.md | Exact-head independent review; retain limits and original logs | 0 run; source read only | [#397](https://github.com/rhyshume1997-alt/tolra-public/pull/397) | DONE (coded); AWAITING CHATGPT REVIEW |
| REC-398 | ChatGPT review packet inventory | Codex; ChatGPT review | docs/agent-control/review-handoffs | Exact-head independent review; retain limits and original logs | 4 / 0 / 0 | [#398](https://github.com/rhyshume1997-alt/tolra-public/pull/398) | DONE (coded); AWAITING CHATGPT REVIEW |

## Follow-up closure in this queue

| Task ID | Objective | Agent | Files | Acceptance criteria | Tests | Branch or PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FIX-378 | Fix both penny findings, keep default off and old profit | Codex | lib/job-profitability-actuals.ts; precision tests | Microseconds cost correctly; unsafe revenue refuses | 61 / 0 / 0; tsc/lint pass; original 2 failures retained | #378, fa5e358 | DONE (coded); AWAITING CHATGPT REVIEW |
| OWN-KEY | Decide separate 500p own-key funding path | Codex | docs/agent-control/own-key-budget-decision.md; tests/reviews/own-key | No platform-key fallback; no overwrite of company budget | 4 / 0 / 0; tsc/lint pass | #399 | DONE (coded); AWAITING CHATGPT REVIEW |
| XERO-CI | Explain actual #396 gate failure | Codex | docs/agent-control/xero396-ci-diagnosis.md; original log | Quote exact failing line; no invented environment cause | Log/source read only; integration job skipped | #400 | DONE (coded); AWAITING CHATGPT REVIEW |
| SAGE-ID | Name exact Sage product/API and limits | Codex | docs/agent-control/sage-product-and-api.md | Main generic export vs #221 v3.1 read-only lookup explicit | Source read only | #401 | DONE (coded); AWAITING CHATGPT REVIEW |
| ACCT-COMPLETE | Reconcile all requested accounting areas | Codex | docs/agent-control/accounting-completeness.md | Main/pending/gaps distinguished; no unsafe stub | Main 159 / 0 / 0; unchanged #216 57 / 0 / 0 | #402 | DONE (coded); AWAITING CHATGPT REVIEW |

Customer account statements/full ledger/statutory reports remain NOT STARTED, pending release-scope/accounting definitions; no clearly small missing implementation was established. Existing pending bank/claim code is not taken over or rebuilt. No task is production-accepted by this board.
