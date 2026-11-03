# Code-only twins — job 30

Updated 3 November 2026. All 18 open mixed code/test PRs now have same-base twins. All 18 latest-head web jobs pass, including #174 after its base-conflict fix. Every twin PR diff contains no docs/ or Markdown changes. #111–113 were already docs-free; #141 is closed and its test file was already copied unchanged into its base at 8eefa3e; #114 was merged and never added docs.

| Old PR | New PR | Same base | Latest web CI |
|---|---|---|---|
| #132 | [#160](https://github.com/rhyshume1997-alt/tolra-public/pull/160) | claude/chase-steps | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583225453/job/125742663317) |
| #134 | [#161](https://github.com/rhyshume1997-alt/tolra-public/pull/161) | chatgpt2/chase-wiring | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583302239/job/125742909992) |
| #135 | [#162](https://github.com/rhyshume1997-alt/tolra-public/pull/162) | chatgpt/costing-wiring | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583450933/job/125743443052) |
| #136 | [#163](https://github.com/rhyshume1997-alt/tolra-public/pull/163) | chatgpt/bank-matcher-more-tests | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583557431/job/125743729843) |
| #137 | [#164](https://github.com/rhyshume1997-alt/tolra-public/pull/164) | chatgpt/paid-claim | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583610206/job/125743882886) |
| #138 | [#165](https://github.com/rhyshume1997-alt/tolra-public/pull/165) | main | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583659203/job/125744044453) |
| #139 | [#166](https://github.com/rhyshume1997-alt/tolra-public/pull/166) | chatgpt2/pr-review | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583713579/job/125744264592) |
| #140 | [#167](https://github.com/rhyshume1997-alt/tolra-public/pull/167) | chatgpt2/plain-english-pass | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583781516/job/125744439568) |
| #144 | [#168](https://github.com/rhyshume1997-alt/tolra-public/pull/168) | chatgpt2/chase-wiring | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583834982/job/125744602201) |
| #145 | [#169](https://github.com/rhyshume1997-alt/tolra-public/pull/169) | chatgpt2/costing-playwright | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583891491/job/125744784980) |
| #146 | [#170](https://github.com/rhyshume1997-alt/tolra-public/pull/170) | chatgpt2/bank-csv-formats | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583942106/job/125744962481) |
| #147 | [#171](https://github.com/rhyshume1997-alt/tolra-public/pull/171) | chatgpt/paid-claim-adapter | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584001125/job/125745154308) |
| #153 | [#172](https://github.com/rhyshume1997-alt/tolra-public/pull/172) | chatgpt2/chase-followup | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584051321/job/125745313005) |
| #154 | [#173](https://github.com/rhyshume1997-alt/tolra-public/pull/173) | chatgpt2/chase-approval-atomic | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584099986/job/125745524365) |
| #155 | [#174](https://github.com/rhyshume1997-alt/tolra-public/pull/174) | chatgpt/costing-wiring | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584678692/job/125747315422) |
| #156 | [#175](https://github.com/rhyshume1997-alt/tolra-public/pull/175) | chatgpt/paid-claim-adapter | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584204643/job/125745826082) |
| #157 | [#176](https://github.com/rhyshume1997-alt/tolra-public/pull/176) | main | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584255674/job/125745994759) |
| #158 | [#177](https://github.com/rhyshume1997-alt/tolra-public/pull/177) | main | [PASS](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584310235/job/125746193688) |

Documentation from the mixed PRs is preserved only in this docs-only handover, indexed in ARCHIVED-MIXED-PR-DOCS.md. Do not merge this docs PR or the original mixed PRs into the public production tree. Code-only is not a safety verdict.

Same-base stacked twins may inherit historical docs. Merely retargeting them to main would expose those inherited docs in the PR diff. Claude must apply only the code commit/diff onto a clean integration branch after its dependencies, then rerun the resulting combined diff and suite. Current commit instructions and review holds are in MERGE-ORDER.md. No Ready label, PR merge, migration application or deployment was performed.
