# Full Vitest evidence — job 32

Checked 3 November 2026 for the exact latest heads of #153–158 (including #155 after the job 31 base fix). No test was weakened. No database suite or proposal SQL was run.

## Completed full CI suites

Actions checkout made a PR merge commit, not a literal checkout of the head SHA. Both commit IDs and their Git tree IDs were fetched and compared: all six tested trees are exactly identical to their corresponding requested head trees. The complete unit suite passed on that identical source/test content. This is explicit tree-equivalence evidence, not a claim the checkout SHA was the same. The exact literal-head local attempts below remain blocked.

| PR | Requested latest head | Files passed | Tests passed | Tests skipped | Failed | CI evidence |
|---|---|---|---|---|---|---|
| #153 | 5d6b2540f82c50fccc1789dfac9799a851a1a172 | 372 | 5024 | 0 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577754413/job/125725640111) |
| #154 | e996332ee4f0f51d223e08c8277406f5c6b3f1e6 | 372 | 5024 | 0 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578114989/job/125726773320) |
| #155 | 62692db767a7b185c0e7d14139ed3a0a53787f6a | 372 | 5076 | 412 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584630432/job/125747175339) |
| #156 | a13ff77ee1d85840f9bb37c87f5aae676a26a84a | 367 | 4983 | 0 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578694180/job/125728653857) |
| #157 | 04598b451b019a986414e5bc92d596a5257c67fd | 373 | 5117 | 0 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578950642/job/125729476982) |
| #158 | 63abc9c1a648c8969289bc696b7907a097e9e138 | 372 | 5051 | 0 | 0 | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41579229222/job/125730340757) |

There were no failed CI assertions to diagnose. #155's 412 skips were the optional pyRound cases: the engine did not export that helper. Enabling them found two real large-value conversion failures. Own code-only PR #182 fixes the double rounding, exports the helper, removes its optional skip, requires all 60 golden quote cases and preserves signed zero. Its focused run reports 474 golden + 16 atomic/labour cases passing, no skips. The original #155 totals above must stay unchanged as historical exact-head evidence.

## Literal-head local attempts

Each run checked out its requested SHA into its own detached worktree, used Node 22.23.4, a writable separate temporary folder and Vitest's default fork pool with at most two workers. All six stopped progressing after the first few files and were stopped at 300 seconds. No whole-suite summary was produced. Their assertion totals are unknown, not zero. A threads-pool retry on #158 also stopped after one file. The root cause of the local worker/lifecycle stall is not established; it is not evidence of a code assertion failure or a passing local suite.

| PR | Exact local SHA | Result | Whole-suite totals |
|---|---|---|---|
| #153 | 5d6b2540f82c50fccc1789dfac9799a851a1a172 | Timed out after 300s | Not available; no completed summary |
| #154 | e996332ee4f0f51d223e08c8277406f5c6b3f1e6 | Timed out after 300s | Not available; no completed summary |
| #155 | 62692db767a7b185c0e7d14139ed3a0a53787f6a | Timed out after 300s | Not available; no completed summary |
| #156 | a13ff77ee1d85840f9bb37c87f5aae676a26a84a | Timed out after 300s | Not available; no completed summary |
| #157 | 04598b451b019a986414e5bc92d596a5257c67fd | Timed out after 300s | Not available; no completed summary |
| #158 | 63abc9c1a648c8969289bc696b7907a097e9e138 | Timed out after 300s | Not available; no completed summary |

Full machine-readable head/checkout/tree/totals evidence: [VITEST-HEAD-EVIDENCE.json](VITEST-HEAD-EVIDENCE.json). Each web job URL above carries the full CI log. Do not confuse a unit-suite pass with database RLS, browser execution, provider delivery, migration application or release approval. Those remain separate checks. If literal checkout identity rather than exact source-tree identity is required, rerun these heads on an unrestricted supported runner; local literal-head verification remains blocked.

## Rounding follow-up #182

Latest code-only head f6f4cc850723fb30dc76012f428b8f05e0fd494b passed its full CI unit suite: Test Files  372 passed (372); Tests  5489 passed (5489). No rounding cases were skipped. Job: [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41586912684/job/125754486397). CI checkout aaf424225e674d1305b7f4b89db02b19719894b5 has the same Git tree 6485b53447bb901ed8710cf094446a4b6d0dd92b as that head. The two newly exposed rounding failures are fixed, not waived; the earlier #155 412-skip count remains the correct historical record for its original head.
