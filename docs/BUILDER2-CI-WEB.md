# Builder 2 exact-head web CI audit

Checked 3 November 2026. Each link is the web job attached to the exact latest PR head shown. No failed web job was found, so no speculative application changes or reruns were made. Documentation-only skips are intentional under .github/workflows/ci.yml (web is skipped when only docs/ or Markdown changes).

| PR | Exact head | CI before | CI after | Evidence |
| --- | --- | --- | --- | --- |
| #132 | 9f08f96dd52cfd9cbffdde913b83a0c9286d32a8 | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41544971372/job/125618344046) |
| #133 | fa2c266778630929f2872b5178f8efc20afe0d1b | SKIPPED (docs only) | SKIPPED (docs only) | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545263154/job/125619239645) |
| #134 | 718baa8b245655ce8e14e00d2f2c416a0adee994 | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545680813/job/125620864386) |
| #135 | a9b71f67ad37336a5bb550b3ce97bd4b7ba623b9 | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41546376191/job/125623462779) |
| #136 | 6c8c7c81b908dbbd8d387262567866c7ae4e2e92 | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41546655592/job/125624406670) |
| #137 | 3b9713c3bb52423770bc138a156906ddf994f66c | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547046715/job/125625447943) |
| #138 | 77643f52a8232da3b60268e39c898580a99b96fd | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547277244/job/125626524552) |
| #139 | e11dc77555f434eb1ca4b1328709ffd4a39f021e | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547616975/job/125627604305) |
| #140 | 9b22b299914a19bcc666c51400b0c1a248ecfc8e | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547889658/job/125628492201) |
| #141 | f6f76ff3cf3fe8abd7c6409018dc6e259dfb7ca7 | PASS | PASS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41548182127/job/125629441537) |
| #142 | dfcb5e4a99d032e8b6e46db968e999610a3ae01f | SKIPPED (docs only) | SKIPPED (docs only) | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549570480/job/125633575220) |
| #143 | 60250211e24589ec984213c05dbd0611e97b4853 | SKIPPED (docs only) | SKIPPED (docs only) | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549887794/job/125634655699) |

Nine passed; three were intentionally skipped. This is web-job evidence, not a claim that integration or ci-gate passed. No Ready label was added. The earlier local whole-suite attempts in #142 remain a historical blocked diagnostic; they must not be confused with these remote web results. If a branch changes during conflict resolution, its new commit needs its own web result.


## Final check after the base merges

Checked again on 3 November 2026. The exact latest heads below supersede the earlier head where job 20 changed it. PASS means the web job completed successfully; SKIPPED is the intentional docs-only path. No failed web job required an application fix.

| PR | Exact latest head | Before job 20 | Latest web result | Evidence |
|---|---|---|---|---|
| #132 | 9f08f96dd52cfd9cbffdde913b83a0c9286d32a8 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41544971372/job/125618344046) |
| #133 | fa2c266778630929f2872b5178f8efc20afe0d1b | Docs-only skip | SKIPPED | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545263154/job/125619239645) |
| #134 | 718baa8b245655ce8e14e00d2f2c416a0adee994 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545680813/job/125620864386) |
| #135 | ed23f6f3ec506210b3449f0e19f9ff34473c81f1 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561855995/job/125674116168) |
| #136 | 6c8c7c81b908dbbd8d387262567866c7ae4e2e92 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41546655592/job/125624406670) |
| #137 | 3b9713c3bb52423770bc138a156906ddf994f66c | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547046715/job/125625447943) |
| #138 | 77643f52a8232da3b60268e39c898580a99b96fd | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547277244/job/125626524552) |
| #139 | bc61c03361d8ac7afb3585cbc140806d441c4e3e | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562415801/job/125675894535) |
| #140 | e9d9f6735726e18c8458702db965d1bf2387e6a6 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562450146/job/125676163676) |
| #141 | f6f76ff3cf3fe8abd7c6409018dc6e259dfb7ca7 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41548182127/job/125629441537) |
| #142 | dfcb5e4a99d032e8b6e46db968e999610a3ae01f | Docs-only skip | SKIPPED | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549570480/job/125633575220) |
| #143 | 60250211e24589ec984213c05dbd0611e97b4853 | Docs-only skip | SKIPPED | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549887794/job/125634655699) |
| #144 | 0cceccd5e4bf70cad740c8b30dfb65ca3a113465 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41559485830/job/125666780391) |
| #145 | b186177bf15cc7a2ddd8c23f57c16d07312746c3 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562492803/job/125676586219) |
| #146 | 8142d8d0ba67e36363dd780b9ac225e191451ce5 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41560741748/job/125670867254) |
| #147 | 190b440a330d79ce28702b89d0659d63ed8424e1 | Pass | SUCCESS | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561091473/job/125672168419) |
| #148 | 6eb787054058876f5de451994ab0aee1495a91c5 | Docs-only skip | SKIPPED | [web job](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561329364/job/125672428783) |

For #132–143: 9 PASS, 3 intentional docs-only SKIP on latest commits. New fixes #144–147: 4 PASS. All code PR web jobs above include typecheck, lint, unit tests, browser collection and build. Browser collection is not execution against a live database; web success does not prove integration/ci-gate success or database/email readiness.
