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
| 3 | [#130](https://github.com/rhyshume1997-alt/tolra-public/pull/130) | `main` | None; keep all owners when joining tracker updates | Docs only; shared ownership | Open #130 → Merge pull request → Create a merge commit |
| 4 | [#107](https://github.com/rhyshume1997-alt/tolra-public/pull/107) | `main` | None; follow with #117, #137, #147 | Invoice/email detection; no payment write | Open #107 → Merge pull request → Create a merge commit |
| 5 | [#108](https://github.com/rhyshume1997-alt/tolra-public/pull/108) | `main` | None; keep progression tests #119 when joining Claude chase base | Invoice/email scheduling | Open #108 → Merge pull request → Create a merge commit |
| 6 | [#109](https://github.com/rhyshume1997-alt/tolra-public/pull/109) | `main` | None; #120 follows | Money/invoice matching | Open #109 → Merge pull request → Create a merge commit |
| 7 | [#110](https://github.com/rhyshume1997-alt/tolra-public/pull/110) | `main` | None; #121 follows; preserve Python parity and rounding | Money/costing | Open #110 → Merge pull request → Create a merge commit |
| 8 | [#111](https://github.com/rhyshume1997-alt/tolra-public/pull/111) | `main` | None; #132 later copies this component | Settings UI; package/lock | Open #111 → Merge pull request → Create a merge commit |
| 9 | [#112](https://github.com/rhyshume1997-alt/tolra-public/pull/112) | `main` | None; #132 later copies this component | Invoice/email approval UI; package/lock | Open #112 → Merge pull request → Create a merge commit |
| 10 | [#113](https://github.com/rhyshume1997-alt/tolra-public/pull/113) | `main` | None; #132 later copies this component | Invoice payment claim UI; package/lock | Open #113 → Merge pull request → Create a merge commit |
| 11 | [#119](https://github.com/rhyshume1997-alt/tolra-public/pull/119) | `chatgpt/chase-steps` | #108 | Tests only; invoice/email dates | Open #119 → Merge pull request → Create a merge commit |
| 12 | [#120](https://github.com/rhyshume1997-alt/tolra-public/pull/120) | `chatgpt/bank-matcher` | #109 | Tests only; money matching | Open #120 → Merge pull request → Create a merge commit |
| 13 | [#121](https://github.com/rhyshume1997-alt/tolra-public/pull/121) | `chatgpt/costing-in-tolra` | #110 | Tests only; money maths | Open #121 → Merge pull request → Create a merge commit |
| 14 | [#131](https://github.com/rhyshume1997-alt/tolra-public/pull/131) | `chatgpt/bank-matcher-more-tests` | #109, #120; preserve quote rejection in #136/#146 | Money CSV guard and tests | Open #131 → Merge pull request → Create a merge commit |
| 15 | [#116](https://github.com/rhyshume1997-alt/tolra-public/pull/116) | `main` | #109, #120, #131; keep their parser fixes | Money/invoice confirmation UI; older parser copy | Open #116 → Merge pull request → Create a merge commit |
| 16 | [#136](https://github.com/rhyshume1997-alt/tolra-public/pull/136) | `chatgpt/bank-matcher-more-tests` | #109, #120, #131, #116; keep all parser tests | Money parser fixes; not tests only | Open #136 → Merge pull request → Create a merge commit |
| 17 | [#117](https://github.com/rhyshume1997-alt/tolra-public/pull/117) | `main` | #107; follow with #137 and #147 before enabling ingestion | Email/invoice suggestion; older detector copy | Open #117 → Merge pull request → Create a merge commit |
| 18 | [#137](https://github.com/rhyshume1997-alt/tolra-public/pull/137) | `chatgpt/paid-claim` | #107, #117; #147 must keep this detector | Email/invoice detector fixes; not tests only | Open #137 → Merge pull request → Create a merge commit |
| 19 | [#118](https://github.com/rhyshume1997-alt/tolra-public/pull/118) | `main` | #108, #119; retain progression logic; join Claude chase base carefully | Invoice/email wording; older steps copy | Open #118 → Merge pull request → Create a merge commit |
| 20 | [#138](https://github.com/rhyshume1997-alt/tolra-public/pull/138) | `main` | None | Money/invoices; invalid overdue date fix; not tests only | Open #138 → Merge pull request → Create a merge commit |
| 21 | [#141](https://github.com/rhyshume1997-alt/tolra-public/pull/141) | `claude/e13-timesheet-days` | Claude timesheet branch first (see prerequisites) | Tests only relative to base; email recipients, dates, duplicate-send | Open #141 → Merge pull request → Create a merge commit |
| 22 | [#123](https://github.com/rhyshume1997-alt/tolra-public/pull/123) | `claude/costing-in-app` | #110, #121 and Claude costing branch first; consolidate overlapping engine/UI | Money/costing; settings and quote pages; inherits migration 143 | Open #123 → Merge pull request → Create a merge commit |
| 23 | [#135](https://github.com/rhyshume1997-alt/tolra-public/pull/135) | `chatgpt/costing-wiring` | #123; preserves #110 engine and fixes preview safety | Money/costing; inherited main auth/migrations already on main | Open #135 → Merge pull request → Create a merge commit |
| 24 | [#115](https://github.com/rhyshume1997-alt/tolra-public/pull/115) | `main` | None; must precede #139 and #147 so guide corrections win | Docs only; older walkthrough | Open #115 → Merge pull request → Create a merge commit |
| 25 | [#139](https://github.com/rhyshume1997-alt/tolra-public/pull/139) | `chatgpt2/pr-review` | #135, #111–113, #115–118, #131, #136; keep later #144/#146 fixes | Money/email UI wording and copied parser/cards; not just text | Open #139 → Merge pull request → Create a merge commit |
| 26 | [#140](https://github.com/rhyshume1997-alt/tolra-public/pull/140) | `chatgpt2/plain-english-pass` | #139 | Browser tests plus optional runner; not tests only; inherited main security | Open #140 → Merge pull request → Create a merge commit |
| 27 | [#132](https://github.com/rhyshume1997-alt/tolra-public/pull/132) | `claude/chase-steps` | #111–113, #108, #118–119 and Claude chase base first; see overlap holds | Invoice/email/auth boundaries; settings/approval/invoice wiring; inherits migration 138 | Open #132 → Merge pull request → Create a merge commit |
| 28 | [#134](https://github.com/rhyshume1997-alt/tolra-public/pull/134) | `chatgpt2/chase-wiring` | #132; preserve selectors when applying #144 | Browser tests plus UI selectors and optional runner; not tests only | Open #134 → Merge pull request → Create a merge commit |
| 29 | [#124](https://github.com/rhyshume1997-alt/tolra-public/pull/124) | `main` | Code reviews above; retain as historical builder 1 handover | Docs only | Open #124 → Merge pull request → Create a merge commit |
| 30 | [#125](https://github.com/rhyshume1997-alt/tolra-public/pull/125) | `main` | None; instructions are not permission to wipe a database | Docs only; destructive operations described, never run here | Open #125 → Merge pull request → Create a merge commit |
| 31 | [#133](https://github.com/rhyshume1997-alt/tolra-public/pull/133) | `main` | Chase/costing guides checked against final screens; fill JNR contact | Docs only; go-live steps | Open #133 → Merge pull request → Create a merge commit |
| 32 | [#142](https://github.com/rhyshume1997-alt/tolra-public/pull/142) | `main` | Preserve evidence; does not claim full local suite passed | Docs only; historical suite evidence | Open #142 → Merge pull request → Create a merge commit |
| 33 | [#143](https://github.com/rhyshume1997-alt/tolra-public/pull/143) | `main` | #142; retain all owners/jobs; the final coordination tracker supersedes snapshots | Docs only; historical handover | Open #143 → Merge pull request → Create a merge commit |

## Fixes newer than the requested range

The order above must not leave known fixes behind. Review these after their parents and before production: #144 after #132/#134 (atomic chase save proposal, reviewed email snapshot, cancelled payment form); #145 after #140 (atomic costing save proposal and machine labour override); #146 after #136 and #139 (awaited bank callbacks, stable same-file retry ID and reference boundaries); #147 after #117/#137/#139 (sender checks, newest detector and corrected staff guide). #148 records earlier exact-head CI; #149 records base merges. Later coordination PRs should be merged last and their ownership tables combined.

There are still production holds: unapplied atomic SQL proposals and DB checks, live browser/email/payment verification, integration CI without adding Ready, missing durable customer IDs in chase data, and bank transaction identity across different exports. A same-file retry ID cannot identify the same transaction in a different export. Incoming sender text does not prove an email is authentic.

## Evidence and review limits

Main was `a546c3a9b37ad53d3ab235b1c545b577b84db9f5`. Job 20 merged it into #135/#139/#140/#145 and joined their updated stacked bases, preserving account security markers 136/137 and costing marker 143 in release preflight. Those auth files and migrations come from main, rather than new costing behaviour. Check the fresh head after every merge. Earlier green CI is historical once the head changes. Historical local full-suite failures/timeouts remain documented; a passing web job is not a live database or email send test.

## Every shared file in the PR changes

Each current PR head was compared with its current base (three-dot Git diff). There are 26 shared paths. [BUILDER2-PR-OVERLAPS.json](BUILDER2-PR-OVERLAPS.json) records all 33 head commits, changed files and conflict pairs. A shared path can merge cleanly and still replace newer behaviour.

| File | PRs changing it | Safest order and what to keep |
|---|---|---|
| components/bank/bank-check.tsx | #116, #139 | #116 → #139 → #146. Keep clear labels, awaited callbacks, pending lock, error retry and stable request ID. |
| components/chase/approval-card.tsx | #112, #132, #139 | #111–113 first, #139 wording before #132/#134 wiring, then #144. Keep selectors, reviewed email snapshot and reopen-after-cancel payment controls. Combine wording into wired components. |
| components/chase/connected-settings.tsx | #132, #134 | #132 → #134 → #144. Keep selectors and #144 atomic save result. Verify SQL proposal first. |
| components/chase/customer-says-paid.tsx | #113, #132, #139 | #111–113 first, #139 wording before #132/#134 wiring, then #144. Keep selectors, reviewed email snapshot and reopen-after-cancel payment controls. Combine wording into wired components. |
| components/chase/settings-card.tsx | #111, #132, #134, #139 | #111–113 first, #139 wording before #132/#134 wiring, then #144. Keep selectors, reviewed email snapshot and reopen-after-cancel payment controls. Combine wording into wired components. |
| components/costing/connected-costing.tsx | #123, #139 | #110 → #123 → #135 → #139 → #145; keep safe estimates, matching preview/quote totals, plain labels, machine labour override and atomic saves. |
| components/costing/costing-rates-editor.tsx | #110, #123, #139 | #110 → #123 → #135 → #139 → #145; keep safe estimates, matching preview/quote totals, plain labels, machine labour override and atomic saves. |
| components/costing/price-this-part.tsx | #110, #123, #135, #139 | #110 → #123 → #135 → #139 → #145; keep safe estimates, matching preview/quote totals, plain labels, machine labour override and atomic saves. |
| components/costing/types.ts | #110, #123 | #110 → #123 → #145; keep machine labour override including zero. |
| docs/BUILDER2-FULL-SUITE-FAILURES.md | #142, #143 | #142 → #143; preserve historical failure evidence. New CI is separate. |
| docs/BUILDER2-FULL-SUITE-RESULTS.json | #142, #143 | #142 → #143; preserve historical failure evidence. New CI is separate. |
| docs/BUILDER2-FULL-SUITE-RUN.md | #142, #143 | #142 → #143; preserve historical failure evidence. New CI is separate. |
| docs/BUILDER2-PR-REVIEW.md | #135, #143 | #135 → #143; preserve findings and append resolutions. |
| docs/CHATGPT-BUILD-HANDOVER-2.md | #132, #133, #134, #135, #136, #137, #138, #139, #140, #141, #142, #143 | Follow the numbered order, combine every job row, then keep the final coordination table. Never choose an older whole file. |
| docs/TOLRA-CODEX-BUILD-HANDOVER.md | #130, #131 | #130 → #131; keep ownership and CSV verification notes. |
| docs/TOLRA-WORK-OWNERSHIP.md | #130, #131, #132, #133, #134, #135, #136, #137, #138, #139, #140, #141, #142, #143 | #130 first; combine Codex and both builders’ rows after every merge. Keep all job/branch/PR details. |
| docs/staff-walkthrough.md | #115, #139 | #115 → #139 → #147; final text must say chosen timesheet days, seasonal daily pass and cost plus percentage (markup). |
| lib/bank/match-statement.ts | #109, #116, #131, #136, #139 | #109 → #120 → #131 → #116 → #136 → #139 → #146. Keep strict quote/date/pence checks, all tests and #146 reference boundaries. |
| lib/chase/paid-claim.ts | #107, #117, #137 | #107 → #117 → #137 → #147. Keep #137/#147 detector; do not restore the older #117 copy. |
| lib/chase/steps.ts | #108, #118 | #108 → #119 → #118, then join Claude chase base before #132. Preserve progression and before-due dates, then wording. |
| lib/costing/engine.ts | #110, #123 | #110 → #121 → Claude costing base → #123; combine fixes. Keep Python rounding, validation and all golden fixtures. #121 inherits a different engine although its own diff is tests only. |
| package-lock.json | #111, #112, #113 | #111 → #112 → #113; combine dependencies once and regenerate the lock consistently. Later #144/#146 need jsdom too. |
| package.json | #111, #112, #113 | #111 → #112 → #113; combine dependencies once and regenerate the lock consistently. Later #144/#146 need jsdom too. |
| tests/support/optional-backend.ts | #134, #140 | #134 → #140; keep no-database skip and both browser runners. |
| tests/unit/bank-match-statement.test.ts | #109, #131 | #109 → #131; keep all assertions, including unclosed quotes. |
| tests/unit/costing-ui.test.ts | #110, #139 | #110 → #139; keep all assertions, changing wording expectations only for intended label changes. |

## Actual text conflicts, including inherited base files

All 528 head pairs were checked with Git merge-tree; 134 pairs have at least one conflict. These include feature-base history, so some paths are absent above. They are pairwise checks, not 134 blocked PRs. Main/base checks in #149 are separate and clean for builder 2 branches. Recheck after each merge.

| Conflicting path | Exact PR pairs (A/B) | Resolution before continuing |
|---|---|---|
| docs/CHATGPT-BUILD-HANDOVER-2.md | 143/142, 143/141, 143/140, 143/139, 143/138, 143/137, 143/136, 143/135, 143/134, 143/133, 143/132, 142/141, 142/140, 142/139, 142/138, 142/137, 142/136, 142/135, 142/134, 142/133, 142/132, 141/140, 141/139, 141/138, 141/137, 141/136, 141/135, 141/134, 141/133, 141/132, 140/138, 140/137, 140/136, 140/134, 140/133, 140/132, 139/138, 139/137, 139/136, 139/134, 139/133, 139/132, 138/137, 138/136, 138/135, 138/134, 138/133, 138/132, 137/136, 137/135, 137/134, 137/133, 137/132, 136/135, 136/134, 136/133, 136/132, 135/134, 135/133, 135/132, 134/133, 133/132 | Follow the numbered order, combine every job row, then keep the final coordination table. Never choose an older whole file. |
| docs/TOLRA-WORK-OWNERSHIP.md | 143/142, 143/141, 143/140, 143/139, 143/138, 143/137, 143/136, 143/135, 143/134, 143/133, 143/132, 143/131, 143/130, 142/141, 142/140, 142/139, 142/138, 142/137, 142/136, 142/135, 142/134, 142/133, 142/132, 142/131, 142/130, 141/140, 141/139, 141/138, 141/137, 141/136, 141/135, 141/134, 141/133, 141/132, 141/131, 141/130, 140/138, 140/137, 140/136, 140/134, 140/133, 140/132, 140/131, 140/130, 139/138, 139/137, 139/136, 139/134, 139/133, 139/132, 139/131, 139/130, 138/137, 138/136, 138/135, 138/134, 138/133, 138/132, 138/131, 138/130, 137/136, 137/135, 137/134, 137/133, 137/132, 137/131, 137/130, 136/135, 136/134, 136/133, 136/132, 136/131, 136/130, 135/134, 135/133, 135/132, 135/131, 135/130, 134/133, 134/131, 134/130, 133/132, 133/131, 133/130, 132/131, 132/130 | #130 first; combine Codex and both builders’ rows after every merge. Keep all job/branch/PR details. |
| supabase/verify/release_preflight.sql | 143/123, 142/123, 141/140, 141/139, 141/135, 141/134, 141/132, 141/123, 140/134, 140/132, 139/134, 139/132, 138/123, 135/134, 135/132, 134/123, 133/123, 132/123, 130/123, 125/123, 124/123, 123/122, 123/118, 123/117, 123/116, 123/115, 123/114, 123/113, 123/112 | Claude must combine main security markers 136/137, chase 138, timesheet 142 and costing 143 as their bases land. Keep every check and SQL commas. Do not choose either whole file or apply SQL here. #123 still needs its owner to join main. |
| components/email-schedules/settings-card.tsx | 141/134, 141/132 | Land chosen-day timesheet base and #141 first, then join chase #132/#134 into that settings card. Keep chosen days, recipients, time and chase controls. |
| components/chase/customer-says-paid.tsx | 140/134, 140/132, 140/113, 139/134, 139/132, 139/113, 134/113, 132/113 | #111–113 first, #139 wording before #132/#134 wiring, then #144. Keep selectors, reviewed email snapshot and reopen-after-cancel payment controls. Combine wording into wired components. |
| components/chase/settings-card.tsx | 140/134, 140/132, 140/111, 139/134, 139/132, 139/111, 134/111 | #111–113 first, #139 wording before #132/#134 wiring, then #144. Keep selectors, reviewed email snapshot and reopen-after-cancel payment controls. Combine wording into wired components. |
| lib/bank/match-statement.ts | 140/131, 140/120, 140/116, 140/109, 139/131, 139/120, 139/116, 139/109, 136/116, 131/116 | #109 → #120 → #131 → #116 → #136 → #139 → #146. Keep strict quote/date/pence checks, all tests and #146 reference boundaries. |
| components/costing/costing-rates-editor.tsx | 140/121, 140/110, 139/121, 139/110 | #110 → #123 → #135 → #139 → #145; keep safe estimates, matching preview/quote totals, plain labels, machine labour override and atomic saves. |
| components/costing/price-this-part.tsx | 140/121, 140/110, 139/121, 139/110, 135/121, 135/110 | #110 → #123 → #135 → #139 → #145; keep safe estimates, matching preview/quote totals, plain labels, machine labour override and atomic saves. |
| lib/costing/engine.ts | 140/121, 139/121, 135/121, 123/121 | #110 → #121 → Claude costing base → #123; combine fixes. Keep Python rounding, validation and all golden fixtures. #121 inherits a different engine although its own diff is tests only. |
| tests/unit/costing-golden.test.ts | 140/121, 140/110, 139/121, 139/110, 135/121, 135/110, 123/121, 123/110 | Keep #110’s 60-case and exact-pence assertions AND Claude’s provenance/coverage checks. Do not replace one suite with a skipped/optional suite, reduce examples or loosen equality. |
| tests/unit/costing-ui.test.ts | 140/121, 140/110, 139/121, 139/110 | #110 → #139; keep all assertions, changing wording expectations only for intended label changes. |
| components/bank/bank-check.tsx | 140/116, 139/116 | #116 → #139 → #146. Keep clear labels, awaited callbacks, pending lock, error retry and stable request ID. |
| docs/staff-walkthrough.md | 140/115, 139/115 | #115 → #139 → #147; final text must say chosen timesheet days, seasonal daily pass and cost plus percentage (markup). |
| lib/chase/paid-claim.ts | 137/117 | #107 → #117 → #137 → #147. Keep #137/#147 detector; do not restore the older #117 copy. |
| lib/chase/steps.ts | 134/118, 132/118, 119/118, 118/108 | #108 → #119 → #118, then join Claude chase base before #132. Preserve progression and before-due dates, then wording. |

## When order is not enough

Combine code where both behaviours are needed. Order cannot prevent regressions in copied modules. Do not accept all of one side. Keep both golden suites, every release marker, and chosen-day email settings with chase settings. Run focused tests and TypeScript/lint after resolving; Claude runs release-wide checks.

Final coordination: the consolidated docs PR also carries this guide, current CI and all ownership rows; merge it after its documentation parents. The latest code-fix web jobs #144–147 passed. #132–143 latest heads have nine web passes and three intentional docs-only skips. See BUILDER2-FINAL-COORDINATION.md for remaining production holds.
