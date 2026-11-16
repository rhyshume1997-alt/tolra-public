# Merge order — current code-only queue

Updated 3 November 2026. This is a docs-only review guide, not a production file. Do not merge this docs PR. No Ready label, PR merge, SQL application or deployment was performed by builder 2.

The independent NOT SAFE verdicts on #117, #123 and #132 still stand for those original versions. The code-only twin of an unsafe version is not automatically safe. Combine parents and fixes before enabling anything. All release decisions below are SAFE WITH CONDITIONS until the stated database, browser and provider checks are complete.

## Start with a clean integration branch

Keep main free of docs/. Never merge an old mixed PR merely to satisfy a stacked base. The requested twins retain the same bases for review; some of those bases contain docs. Simply retargeting a twin to main can make inherited docs appear as additions. Instead apply only the listed code commit to the clean integration branch in dependency order, resolve overlaps while retaining every test, and open/review a fresh docs-free integration diff. Recheck that diff and full CI. These commands are instructions for Claude's authorised integration work, not commands builder 2 ran to merge PRs.

Claude must first open/review the source base work: claude/chase-steps (138), claude/costing-in-app (143), claude/e13-timesheet-days (142) and claude/sliq-import (140/141). There are no PRs with these exact head branches in the current GitHub lookup. Do not invent PR numbers. No database change may be considered verified merely because the files exist.

## Order and canonical versions

1. Keep already merged main tests #114/#122. #119/#120/#121 are merged into their feature bases, not main; preserve them when joining #108/#109/#110. #141 is closed, but its exact 25-test file is already in the updated Claude timesheet base; do not duplicate or drop it.
2. Join reviewed Claude base code/schema files through Claude's own release process; preserve every existing release preflight marker and all company/auth checks. Keep TypeScript engine tests and both Python golden suites.
3. Take #165 receivables rules, canonical #176 paid detector/adapter, and #177 bank parser. These main-based code commits include the original relevant assertion sets. Older #107/#117/#137/#147 detector copies and #109/#116/#131/#136/#139 parser copies must not overwrite them. Close/supersede older PRs only after their unique tests/changes are accounted for; builder 2 has not closed them.
4. Join chase cards/tests (#111–113), #160 wiring, #161 browser selectors, #168 follow-up and #172 final reviewed-text/atomic settings paths, plus #180 duplicate-customer and credited-total guards. #160/#132 cannot ship alone. Keep the latest exact reviewed subject/body claim and all old component assertions; update callback assertions to include the new reviewed snapshot rather than deleting tests.
5. Join costing #110/#121, Claude rates base and #123's page mounts only together with canonical #174 atomic wiring. #174 contains the #145-style atomic helper, machine labour override, finite preview and plain labels; #162/#166/#169 overlap it. Keep unique regression tests without restoring older components. Follow #174 with #182 for the two large-value rounding failures and all 412 previously optional rounding cases. #167 provides browser smoke checks; collection/skips are not live browser tests.
6. Join #170 bank confirmation UI with canonical #177 parser. Do not auto-post. Connect the parent-page callback to scoped invoice data, refresh only after success, and agree persistent transaction identity across exports before claiming full reconciliation.
7. Apply #181 SliQ numeric guard to the reviewed importer base. Do not run an import or any proposal SQL as part of merging code. The parser patch itself is pure and database-free.
8. Keep #173's throwaway SQL tests and rollback with the final #172/#174 proposal signatures. They remain unrun. Verify permissions/concurrency/rollback against the full disposable schema as well as the portable fixture before Claude packages/applies migrations.
9. Take #179 manual plan outside docs/. Run and record the manual checks with test users/data/mailboxes. Run the complete combined suite; separate green PR jobs do not prove the combined stack is green.

## Every old mixed PR and its code-only twin

All 18 twins passed latest-head web CI at this check. Existing same bases are listed to avoid accidental merges of docs-bearing ancestry. The command is the twin's code commit, not an instruction to merge its old parent.

| Old PR | Code-only PR | Same base | Review condition / version to keep | Verdict | One code action after prerequisites |
|---|---|---|---|---|---|
| #132 | [#160](https://github.com/rhyshume1997-alt/tolra-public/pull/160) | claude/chase-steps | Chase wiring: Claude chase base / 138; then #161 selectors and #172 reviewed-text fix, #180 ambiguity/credit-total fix. | NOT SAFE alone | `git cherry-pick b3287117bdcf95f46734b134a52e9790dbcdad61` |
| #134 | [#161](https://github.com/rhyshume1997-alt/tolra-public/pull/161) | chatgpt2/chase-wiring | Chase browser tests: #160; preserve selectors when adding #172; actual browser execution still needed. | SAFE WITH CONDITIONS | `git cherry-pick 011a8516b33c27b3ae5535c74a78819969226a2c` |
| #135 | [#162](https://github.com/rhyshume1997-alt/tolra-public/pull/162) | chatgpt/costing-wiring | Costing preview review: Code already covered by #174; keep regression tests when consolidating, not an extra old component copy. | SAFE WITH CONDITIONS | `git cherry-pick 5a1af490588494604c79ede274129b9a4f8a8bde` |
| #136 | [#163](https://github.com/rhyshume1997-alt/tolra-public/pull/163) | chatgpt/bank-matcher-more-tests | Bank formats: Code/tests covered by #177; do not overwrite #177 with the older matcher. | SAFE WITH CONDITIONS | `git cherry-pick 12067894a12a30c6b838389dcd3f122e959b4cb3` |
| #137 | [#164](https://github.com/rhyshume1997-alt/tolra-public/pull/164) | chatgpt/paid-claim | UK paid wording: Code/tests covered by #176. | SAFE WITH CONDITIONS | `git cherry-pick e6022261998e6d0c3313bccef88441a81e0399af` |
| #138 | [#165](https://github.com/rhyshume1997-alt/tolra-public/pull/165) | main | Receivables/date rules: Main; money/invoice checks and complete suite after integration. | SAFE WITH CONDITIONS | `git cherry-pick 40bfae270993013b0d56c176b8e99dd49daec61b` |
| #139 | [#166](https://github.com/rhyshume1997-alt/tolra-public/pull/166) | chatgpt2/pr-review | Plain wording: Apply wording without restoring old bank/chase/costing copies; canonical #172/#174/#176/#177 win. | SAFE WITH CONDITIONS | `git cherry-pick 276c56ca8b67800f28e238ae05f13861747d3c77` |
| #140 | [#167](https://github.com/rhyshume1997-alt/tolra-public/pull/167) | chatgpt2/plain-english-pass | Costing browser tests: Costing stack; keep optional backend helper shared with #161; live browser execution remains. | SAFE WITH CONDITIONS | `git cherry-pick c1a3c327d35dde35ae724505287d2f55a1edde96` |
| #144 | [#168](https://github.com/rhyshume1997-alt/tolra-public/pull/168) | chatgpt2/chase-wiring | Chase save/claim follow-up: #160; then #172's explicit-company RPC and approval claim must win. | SAFE WITH CONDITIONS | `git cherry-pick 8e34d8c30ea2c86ea16855e2cd5539c40f62a9fb` |
| #145 | [#169](https://github.com/rhyshume1997-alt/tolra-public/pull/169) | chatgpt2/costing-playwright | Costing atomic alternative: Same implementation family as #174, but on costing-browser base. Pick one canonical atomic implementation; prefer #174 then #182. | SAFE WITH CONDITIONS | `git cherry-pick b56d38355ff30f2c330ba9daffda616e94e9f6a5` |
| #146 | [#170](https://github.com/rhyshume1997-alt/tolra-public/pull/170) | chatgpt2/bank-csv-formats | Bank confirmation UI: Join UI/tests/dependencies with #177 parser; preserve awaited callback/retry ID; parent page connection remains. | SAFE WITH CONDITIONS | `git cherry-pick dfa8c17090790c76814c2548a54b6344a6e80323` |
| #147 | [#171](https://github.com/rhyshume1997-alt/tolra-public/pull/171) | chatgpt/paid-claim-adapter | Older sender follow-up: Superseded by #175/#176. Staff guide is preserved only in docs PR. | SAFE WITH CONDITIONS | `git cherry-pick 9d29c3b3aa129934f73c79469f3316b28d86aa66` |
| #153 | [#172](https://github.com/rhyshume1997-alt/tolra-public/pull/172) | chatgpt2/chase-followup | Reviewed chase approval: #168 and verified explicit-company chase RPC; also preserve #180 guards and #161 selectors. | SAFE WITH CONDITIONS | `git cherry-pick adefac577d1ceec79fc6296d39294587b60c4013` |
| #154 | [#173](https://github.com/rhyshume1997-alt/tolra-public/pull/173) | chatgpt2/chase-approval-atomic | Atomic SQL test runner: #172 proposal signature; SQL cases NOT RUN; portable fixture not full production auth/RLS. | SAFE WITH CONDITIONS | `git cherry-pick 968475f1a7ec1558dfcf5f1435c6b3f415318096` |
| #155 | [#174](https://github.com/rhyshume1997-alt/tolra-public/pull/174) | chatgpt/costing-wiring | Atomic costing wiring: Claude costing / 143 plus TypeScript engine/UI; verified costing RPC. Base conflict resolved. Follow with #182. | SAFE WITH CONDITIONS | `git cherry-pick 80f7d19bf0255b633ee62738440ac72efd35a162` |
| #156 | [#175](https://github.com/rhyshume1997-alt/tolra-public/pull/175) | chatgpt/paid-claim-adapter | Strict sender adapter: Code/tests included by #176; provider sender authentication remains separate. | SAFE WITH CONDITIONS | `git cherry-pick 356c31916101afd0776198c1fd2ed7b4752adb44` |
| #157 | [#176](https://github.com/rhyshume1997-alt/tolra-public/pull/176) | main | Canonical paid claims: Latest main; includes original detector/adapter/UK/sender assertions. Keep after all old copies; suggestions only. | SAFE WITH CONDITIONS | `git cherry-pick 71c56fff162c72635936d86fa7d5e113a7bac6dd` |
| #158 | [#177](https://github.com/rhyshume1997-alt/tolra-public/pull/177) | main | Canonical bank parser: Latest main; includes all original quote/format/matcher assertions; no auto-posting. | SAFE WITH CONDITIONS | `git cherry-pick a24f875e5e12ccdb41e1e2afae2df73992d73741` |

#174's listed commit is its original code-only commit. Its later main merge resolves ancestry/preflight and keeps all Markdown unchanged. A clean integration branch already containing current main and reviewed costing base must retain main security markers 136/137 and costing 143. Do not cherry-pick the merge commit without understanding its parents. Compare the final relevant code with latest #174 and rerun CI; do not copy old whole preflight files.

The table gives review/application commands, not permission to apply a superseded whole copy. Rows marked covered/superseded need no duplicate commit if canonical #176/#177/#174 already supplies their code/tests. Resolve add/add conflicts using canonical code plus every unique assertion, not accepting a whole old side. Bank/chase/costing copies are semantic overlaps even when Git merges cleanly.

## New review and manual-check PRs

| PR | Base | What must be retained | Verdict | Action after prerequisites |
|---|---|---|---|---|
| [#179](https://github.com/rhyshume1997-alt/tolra-public/pull/179) | main | Only tests/MANUAL-CHECKS.md; written plan, not executed checks | SAFE WITH CONDITIONS | `git cherry-pick 7eb0406c7a8003d1106227612506ea5cc4fc00bf` |
| [#180](https://github.com/rhyshume1997-alt/tolra-public/pull/180) | claude/chase-steps | Fail closed on same-name customers in drafting/approval; preserve original invoice total after credits; combine with #172 | SAFE WITH CONDITIONS | `git cherry-pick 46807ed5b58b2c4cba313ce12ddcfb2bca8c0505` |
| [#181](https://github.com/rhyshume1997-alt/tolra-public/pull/181) | claude/sliq-import | Reject unsafe/infinite SliQ quantity/percentage integers; preserve all existing parsing assertions | SAFE WITH CONDITIONS | `git cherry-pick 26d6f57958962d6c40005055c1929fb6039e9802` |
| [#182](https://github.com/rhyshume1997-alt/tolra-public/pull/182) | chatgpt2/costing-wiring-atomic-code-only | Fix large-value double conversion, preserve signed zero, run all 412 Python rounding cases and require 60 golden examples | SAFE WITH CONDITIONS | `git cherry-pick f6f4cc850723fb30dc76012f428b8f05e0fd494b` |

## Evidence, original verdicts and remaining holds

- [Code-only matrix and latest web jobs](CODE-ONLY-TWINS.md).
- [Full Vitest totals and head/tree proof](VITEST-HEAD-EVIDENCE.md): no CI assertion failures on #153–158's identical head trees. CI checkout commits differ; literal local-head runs timed out. #155's 412 skipped cases led to #182's real fix. Keep those historical counts unchanged.
- [Branch review and comment links](CODE-BRANCH-REVIEW.md). Source PR comments are blocked because no exact Claude source-head PRs exist; findings are posted on #178 and own fixes.
- [Original per-PR verdict/order snapshot](MERGE-ORDER-HISTORY-29.md). Historical holds are superseded only where this guide explicitly records a fix; original independent NOT SAFE decisions remain visible.
- [Archived documentation from mixed PRs](ARCHIVED-MIXED-PR-DOCS.md) stays only in the docs PR. No docs-only PR (#178 included) is a production merge candidate.

Production holds: proposal SQL/RLS/concurrency/rollback verification and packaging; live browser/mail/payment checks; durable invoice-customer IDs; bank parent-page connection and cross-export identity; provider email authenticity; filled JNR support contacts. Literal local-head full-suite completion remains blocked by an undiagnosed worker stall. No failed assertion is waived and no test is weakened. All new PRs remain drafts without Ready labels.

Final CI: all 18 twins and all three new review fixes (#180/#181/#182) pass latest-head web checks. #182 full suite: Test Files  372 passed (372); Tests  5489 passed (5489); no rounding skips. Manual-plan #179 is a documentation-only change outside docs/.
