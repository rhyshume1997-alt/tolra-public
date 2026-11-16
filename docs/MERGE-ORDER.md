# Merge order for Claude Code

Checked 3 November 2026. This covers all 33 open PRs numbered #107–143. Numbers #126–129 are not PRs in this open set. No PR was merged, no Ready label added and no SQL applied by builder 2.

Use this as the order for review and integration, not permission to release unfinished work. Rows marked with dependencies must wait for them. A clean Git merge does not prove that copied code is the newest version. Keep every existing test; resolve the overlap holds before enabling the features.

Before each merge, review the latest commit, require its CI checks, and have the owner mark the draft ready for review. Do not add the Ready label. Choose **Create a merge commit**, not squash, for these stacked branches. Keep base branches until their children have moved to main. Once a base has been merged, change the child PR base to main, refresh its diff and checks, then use the click listed below. Do not merge a child back into a feature branch that has already been merged: that leaves the child out of main.

## Claude base branches must come first

| Before | Branch | What Claude needs to do |
|---|---|---|
| #132 | `claude/chase-steps` | Open/review its own PR into main, join #108/#118 progression and wording without losing either, review migration 138, routes `/api/chase/run` and `/api/chase/approve`, auth and email send guards. Merge the base before retargeting #132. |
| #123 | `claude/costing-in-app` | Open/review its own PR into main; review migration 143, company scoping and money storage. The TypeScript engine in #110 is separate from this base: keep its parity tests. Merge the base before retargeting #123. |
| #141 | `claude/e13-timesheet-days` | Open/review its own PR into main; review migration 142, company/recipient checks, chosen days, daylight saving and duplicate-send protection. Merge the base before retargeting #141. |

These three branches have no open PR in the inspected list. Do not invent a PR number or bypass their review. The SQL proposals in #144 and #145 are separate, unapplied proposals, not replacements for these migrations. Claude must verify and package them before the atomic save UIs can work in production.

## Exact order within #107–143

Tests-only PRs #114 and #122 can go first immediately. #119, #120, #121 and #141 are tests only relative to their listed bases, so wait for those bases. #136, #137 and #138 contain code fixes; #134 and #140 include UI/runner changes. Do not call those tests only.

| Order | PR | Current base | Needs first / review condition | Risk or scope | One merge click after review |
|---|---|---|---|---|---|
| 1 | [#114](https://github.com/rhyshume1997-alt/tolra-public/pull/114) | `main` | None | Tests only; SliQ imports | Open #114 → Merge pull request → Create a merge commit |
| 2 | [#122](https://github.com/rhyshume1997-alt/tolra-public/pull/122) | `main` | None | Tests only; SliQ imports | Open #122 → Merge pull request → Create a merge commit |
| 3 | [#107](https://github.com/rhyshume1997-alt/tolra-public/pull/107) | `main` | None; follow with #117, #137, #147 | Invoice/email detection; no payment write | Open #107 → Merge pull request → Create a merge commit |
| 4 | [#108](https://github.com/rhyshume1997-alt/tolra-public/pull/108) | `main` | None; keep progression tests #119 when joining Claude chase base | Invoice/email scheduling | Open #108 → Merge pull request → Create a merge commit |
| 5 | [#109](https://github.com/rhyshume1997-alt/tolra-public/pull/109) | `main` | None; #120 follows | Money/invoice matching | Open #109 → Merge pull request → Create a merge commit |
| 6 | [#110](https://github.com/rhyshume1997-alt/tolra-public/pull/110) | `main` | None; #121 follows; preserve Python parity and rounding | Money/costing | Open #110 → Merge pull request → Create a merge commit |
| 7 | [#111](https://github.com/rhyshume1997-alt/tolra-public/pull/111) | `main` | None; #132 later copies this component | Settings UI; package/lock | Open #111 → Merge pull request → Create a merge commit |
| 8 | [#112](https://github.com/rhyshume1997-alt/tolra-public/pull/112) | `main` | None; #132 later copies this component | Invoice/email approval UI; package/lock | Open #112 → Merge pull request → Create a merge commit |
| 9 | [#113](https://github.com/rhyshume1997-alt/tolra-public/pull/113) | `main` | None; #132 later copies this component | Invoice payment claim UI; package/lock | Open #113 → Merge pull request → Create a merge commit |
| 10 | [#119](https://github.com/rhyshume1997-alt/tolra-public/pull/119) | `chatgpt/chase-steps` | #108 | Tests only; invoice/email dates | Open #119 → Merge pull request → Create a merge commit |
| 11 | [#120](https://github.com/rhyshume1997-alt/tolra-public/pull/120) | `chatgpt/bank-matcher` | #109 | Tests only; money matching | Open #120 → Merge pull request → Create a merge commit |
| 12 | [#121](https://github.com/rhyshume1997-alt/tolra-public/pull/121) | `chatgpt/costing-in-tolra` | #110 | Tests only; money maths | Open #121 → Merge pull request → Create a merge commit |
| 13 | [#131](https://github.com/rhyshume1997-alt/tolra-public/pull/131) | `chatgpt/bank-matcher-more-tests` | #109, #120; preserve quote rejection in #136/#146 | Money CSV guard and tests | Open #131 → Merge pull request → Create a merge commit |
| 14 | [#116](https://github.com/rhyshume1997-alt/tolra-public/pull/116) | `main` | #109, #120, #131; keep their parser fixes | Money/invoice confirmation UI; older parser copy | Open #116 → Merge pull request → Create a merge commit |
| 15 | [#136](https://github.com/rhyshume1997-alt/tolra-public/pull/136) | `chatgpt/bank-matcher-more-tests` | #109, #120, #131, #116; keep all parser tests | Money parser fixes; not tests only | Open #136 → Merge pull request → Create a merge commit |
| 16 | [#117](https://github.com/rhyshume1997-alt/tolra-public/pull/117) | `main` | #107; follow with #137 and #147 before enabling ingestion | Email/invoice suggestion; older detector copy | Open #117 → Merge pull request → Create a merge commit |
| 17 | [#137](https://github.com/rhyshume1997-alt/tolra-public/pull/137) | `chatgpt/paid-claim` | #107, #117; #147 must keep this detector | Email/invoice detector fixes; not tests only | Open #137 → Merge pull request → Create a merge commit |
| 18 | [#118](https://github.com/rhyshume1997-alt/tolra-public/pull/118) | `main` | #108, #119; retain progression logic; join Claude chase base carefully | Invoice/email wording; older steps copy | Open #118 → Merge pull request → Create a merge commit |
| 19 | [#138](https://github.com/rhyshume1997-alt/tolra-public/pull/138) | `main` | None | Money/invoices; invalid overdue date fix; not tests only | Open #138 → Merge pull request → Create a merge commit |
| 20 | [#141](https://github.com/rhyshume1997-alt/tolra-public/pull/141) | `claude/e13-timesheet-days` | Claude timesheet branch first (see prerequisites) | Tests only relative to base; email recipients, dates, duplicate-send | Open #141 → Merge pull request → Create a merge commit |
| 21 | [#123](https://github.com/rhyshume1997-alt/tolra-public/pull/123) | `claude/costing-in-app` | #110, #121 and Claude costing branch first; consolidate overlapping engine/UI | Money/costing; settings and quote pages; inherits migration 143 | Open #123 → Merge pull request → Create a merge commit |
| 22 | [#135](https://github.com/rhyshume1997-alt/tolra-public/pull/135) | `chatgpt/costing-wiring` | #123; preserves #110 engine and fixes preview safety | Money/costing; inherited main auth/migrations already on main | Open #135 → Merge pull request → Create a merge commit |
| 23 | [#115](https://github.com/rhyshume1997-alt/tolra-public/pull/115) | `main` | None; must precede #139 and #147 so guide corrections win | Docs only; older walkthrough | Open #115 → Merge pull request → Create a merge commit |
| 24 | [#139](https://github.com/rhyshume1997-alt/tolra-public/pull/139) | `chatgpt2/pr-review` | #135, #111–113, #115–118, #131, #136; keep later #144/#146 fixes | Money/email UI wording and copied parser/cards; not just text | Open #139 → Merge pull request → Create a merge commit |
| 25 | [#140](https://github.com/rhyshume1997-alt/tolra-public/pull/140) | `chatgpt2/plain-english-pass` | #139 | Browser tests plus optional runner; not tests only; inherited main security | Open #140 → Merge pull request → Create a merge commit |
| 26 | [#132](https://github.com/rhyshume1997-alt/tolra-public/pull/132) | `claude/chase-steps` | #111–113, #108, #118–119 and Claude chase base first; see overlap holds | Invoice/email/auth boundaries; settings/approval/invoice wiring; inherits migration 138 | Open #132 → Merge pull request → Create a merge commit |
| 27 | [#134](https://github.com/rhyshume1997-alt/tolra-public/pull/134) | `chatgpt2/chase-wiring` | #132; preserve selectors when applying #144 | Browser tests plus UI selectors and optional runner; not tests only | Open #134 → Merge pull request → Create a merge commit |
| 28 | [#124](https://github.com/rhyshume1997-alt/tolra-public/pull/124) | `main` | Code reviews above; retain as historical builder 1 handover | Docs only | Open #124 → Merge pull request → Create a merge commit |
| 29 | [#125](https://github.com/rhyshume1997-alt/tolra-public/pull/125) | `main` | None; instructions are not permission to wipe a database | Docs only; destructive operations described, never run here | Open #125 → Merge pull request → Create a merge commit |
| 30 | [#130](https://github.com/rhyshume1997-alt/tolra-public/pull/130) | `main` | None; keep all owners when joining tracker updates | Docs only; shared ownership | Open #130 → Merge pull request → Create a merge commit |
| 31 | [#133](https://github.com/rhyshume1997-alt/tolra-public/pull/133) | `main` | Chase/costing guides checked against final screens; fill JNR contact | Docs only; go-live steps | Open #133 → Merge pull request → Create a merge commit |
| 32 | [#142](https://github.com/rhyshume1997-alt/tolra-public/pull/142) | `main` | Preserve evidence; does not claim full local suite passed | Docs only; historical suite evidence | Open #142 → Merge pull request → Create a merge commit |
| 33 | [#143](https://github.com/rhyshume1997-alt/tolra-public/pull/143) | `main` | #142; retain all owners/jobs; final tracker #152 or later supersedes snapshots | Docs only; historical handover | Open #143 → Merge pull request → Create a merge commit |

## Fixes newer than the requested range

The order above must not leave known fixes behind. Review these after their parents and before production: #144 after #132/#134 (atomic chase save proposal, reviewed email snapshot, cancelled payment form); #145 after #140 (atomic costing save proposal and machine labour override); #146 after #136 and #139 (awaited bank callbacks, stable same-file retry ID and reference boundaries); #147 after #117/#137/#139 (sender checks, newest detector and corrected staff guide). #148 records earlier exact-head CI; #149 records base merges. Later coordination PRs should be merged last and their ownership tables combined.

There are still production holds: unapplied atomic SQL proposals and DB checks, live browser/email/payment verification, integration CI without adding Ready, missing durable customer IDs in chase data, and bank transaction identity across different exports. A same-file retry ID cannot identify the same transaction in a different export. Incoming sender text does not prove an email is authentic.

## Evidence and review limits

Main was `a546c3a9b37ad53d3ab235b1c545b577b84db9f5`. Job 20 merged it into #135/#139/#140/#145 and joined their updated stacked bases, preserving account security markers 136/137 and costing marker 143 in release preflight. Those auth files and migrations come from main, rather than new costing behaviour. Check the fresh head after every merge. Earlier green CI is historical once the head changes. Historical local full-suite failures/timeouts remain documented; a passing web job is not a live database or email send test.
