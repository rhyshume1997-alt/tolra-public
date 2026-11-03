# Code-only twins — job 30

Checked 3 November 2026. All 18 open code/test PRs with docs changes have a twin on the same current base. The new PR diff contains no docs/ or Markdown changes. #111–113 already had no docs changes. #141 is closed; its 25-test file is already identical on claude/e13-timesheet-days (8eefa3e), so no duplicate empty PR was opened. #114 was merged and had no docs changes.

| Old PR | Code-only PR | Same base | Web CI at check |
|---|---|---|---|
| #132 | [#160](https://github.com/rhyshume1997-alt/tolra-public/pull/160) | claude/chase-steps | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583225453/job/125742663317) |
| #134 | [#161](https://github.com/rhyshume1997-alt/tolra-public/pull/161) | chatgpt2/chase-wiring | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583302239/job/125742909992) |
| #135 | [#162](https://github.com/rhyshume1997-alt/tolra-public/pull/162) | chatgpt/costing-wiring | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583450933/job/125743443052) |
| #136 | [#163](https://github.com/rhyshume1997-alt/tolra-public/pull/163) | chatgpt/bank-matcher-more-tests | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583557431/job/125743729843) |
| #137 | [#164](https://github.com/rhyshume1997-alt/tolra-public/pull/164) | chatgpt/paid-claim | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583610206/job/125743882886) |
| #138 | [#165](https://github.com/rhyshume1997-alt/tolra-public/pull/165) | main | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583659203/job/125744044453) |
| #139 | [#166](https://github.com/rhyshume1997-alt/tolra-public/pull/166) | chatgpt2/pr-review | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583713579/job/125744264592) |
| #140 | [#167](https://github.com/rhyshume1997-alt/tolra-public/pull/167) | chatgpt2/plain-english-pass | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583781516/job/125744439568) |
| #144 | [#168](https://github.com/rhyshume1997-alt/tolra-public/pull/168) | chatgpt2/chase-wiring | [success](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583834982/job/125744602201) |
| #145 | [#169](https://github.com/rhyshume1997-alt/tolra-public/pull/169) | chatgpt2/costing-playwright | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583891491/job/125744784980) |
| #146 | [#170](https://github.com/rhyshume1997-alt/tolra-public/pull/170) | chatgpt2/bank-csv-formats | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583942106/job/125744962481) |
| #147 | [#171](https://github.com/rhyshume1997-alt/tolra-public/pull/171) | chatgpt/paid-claim-adapter | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584001125/job/125745154308) |
| #153 | [#172](https://github.com/rhyshume1997-alt/tolra-public/pull/172) | chatgpt2/chase-followup | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584051321/job/125745313005) |
| #154 | [#173](https://github.com/rhyshume1997-alt/tolra-public/pull/173) | chatgpt2/chase-approval-atomic | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584099986/job/125745524365) |
| #155 | [#174](https://github.com/rhyshume1997-alt/tolra-public/pull/174) | chatgpt/costing-wiring | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584146382/job/125745650727) |
| #156 | [#175](https://github.com/rhyshume1997-alt/tolra-public/pull/175) | chatgpt/paid-claim-adapter | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584204643/job/125745826082) |
| #157 | [#176](https://github.com/rhyshume1997-alt/tolra-public/pull/176) | main | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584255674/job/125745994759) |
| #158 | [#177](https://github.com/rhyshume1997-alt/tolra-public/pull/177) | main | [in_progress](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584310235/job/125746193688) |

Documentation and ownership stay in this docs-only coordination PR; do not merge it into the public production tree. Original mixed PRs stay as reference and must not be used to ship code.

Some required same bases contain docs from old mixed PRs. Do not simply retarget such a twin to main: inherited docs would appear in the new diff. Claude must cherry-pick only the twin’s single code commit onto a clean integration branch after its code dependencies, then recheck the resulting diff and CI. Do not merge original docs-bearing base branches into production. All review, money/auth/email and unrun SQL conditions still apply; code-only is not a safety verdict.
