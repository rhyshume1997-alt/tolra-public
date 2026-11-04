# Builder 4 next-queue handover

Prepared 4 November 2026. All twelve item codes explicitly assigned by Rhys and claimed atomically before edits; one draft per code. Original implementation/coordination branches unchanged. Read root AGENTS.md, prior #295 handover, requested #257 handover and current #271 ownership. Docs are under docs/signoff/; every job has its own HANDOVER-<code>.md.

| Item | Draft | Sheet under docs/signoff/ | Published head at handover |
| --- | --- | --- | --- |
| G14 | [#301](https://github.com/rhyshume1997-alt/tolra-public/pull/301) | `G14-GO-LIVE-DAY-AGREEMENT.md` | `475e186b5b9d4fd526c9c95028c49eeb96aa63c5` |
| F6 | [#302](https://github.com/rhyshume1997-alt/tolra-public/pull/302) | `F6-JOHN-ACCEPTANCE.md` | `e76f1c03ee5cd60f3048d5c5a115714e4b3c54bd` |
| AI-APPROVE | [#303](https://github.com/rhyshume1997-alt/tolra-public/pull/303) | `AI-APPROVE-JOHN-DATA-SHARING.md` | `ca1c504cf515d82533242bf373c38d2f069642fc` |
| B13 | [#304](https://github.com/rhyshume1997-alt/tolra-public/pull/304) | `B13-JOHN-REHEARSAL-WEEK.md` | `97422fe71066c8e4d225d0d38f2da837f88b4ed5` |
| B15 | [#306](https://github.com/rhyshume1997-alt/tolra-public/pull/306) | `B15-REMOVE-RHUMECOACHING-ADMIN.md` | `99a1a9f6e9e10b5ce7b92183a87c778b8e9fe953` |
| B17 | [#307](https://github.com/rhyshume1997-alt/tolra-public/pull/307) | `B17-ADMIN-SIGN-IN-CODES.md` | `8877aed34d009c7dc1c348d81932ffe103190805` |
| C8 | [#308](https://github.com/rhyshume1997-alt/tolra-public/pull/308) | `C8-DECISION-MAKERS-AND-SUPPORT.md` | `289eeb67ff8535a647e9c01ddb5eadef71e411fe` |
| D7 | [#309](https://github.com/rhyshume1997-alt/tolra-public/pull/309) | `D7-SIX-YEAR-FINANCIAL-RETENTION.md` | `2562523258932a489b40862bf0f9a5e2657b8305` |
| NUM-RESET | [#310](https://github.com/rhyshume1997-alt/tolra-public/pull/310) | `NUM-RESET-JOHN-NUMBERING-CHOICE.md` | `597a195c99b2d7cb20d494f489632889dfeb45da` |
| XERO-APP | [#311](https://github.com/rhyshume1997-alt/tolra-public/pull/311) | `XERO-APP-RHYS-REGISTRATION.md` | `54e28c086dd20cd6553b53e3645b6a51c8d13ec2` |
| SAGE-QBO-APP | [#312](https://github.com/rhyshume1997-alt/tolra-public/pull/312) | `SAGE-QBO-APP-RHYS-REGISTRATION.md` | `bf5396b66e163cadaf5a212b268a3519f6f4b5cb` |
| PAID-ROUND | [#313](https://github.com/rhyshume1997-alt/tolra-public/pull/313) | `PAID-ROUND-JOHN-PAID-TIME-CHOICE.md` | `7ffeb44be92ce10fcace40ddce12a509d3d675c7` |

Cross-review is this separate draft into #305's `codex/cu-first-day-smoke`, not main. `BUILDER-3-CROSS-REVIEW.md` records exact snapshots #285–#289 plus #298/#299/#300/#305, findings, unchanged conditions and actual checks. It carries CN's complete sibling guide with narrow corrections because that guide was absent from #305. It corrects its real-data external-AI boundary and unsupported Sage/QBO export instructions, plus CU's optional-MFA wording and overly broad AI-off proof implication. No runtime permissions, arithmetic, SQL or feature scope changed.

All review/ownership corrections are proposed in our branch only. CR's valid corrections to builder 4's earlier #294 accounting source path and #296 cap-off instruction are retained through the #305 base. **Do not overwrite those corrections with the older original strings when integrating.** A cap equal to used-plus-reserved is not an off switch: settlement/refund may release headroom. Use the existing feature-off control. No duplicate code fix was invented.

## What was actually checked

- All blank forms: source/control/example/date/diff review. G14 is a compact 349-word one-page master; actual print preview and John appointment/signature NOT RUN. No artificial tests for blank paperwork.
- Rhys confirmed PAID-ROUND means **paid working time**. Current exact-time calculation, final-total nearest-minute rounding, half-minute examples and decimal export distinction are stated. No payroll policy/rate or rounding implementation changed. John/payroll adviser still must decide using actual examples.
- CM #285 exact detached worktree: 9 setup tests passed, 0 failed/skipped; typecheck and explicit helper/test ESLint passed. Shared preinstalled dependencies, not a clean locked install or full suite/CI result.
- CQ #289 exact detached worktree: 3 acceptance tests in 3 files collected; changed N1-spec ESLint passed. No browser assertion or SQL executed. Missing backend remains an unproved condition, not a passed test.
- CS/CT: checked 281 pinned source-line link occurrences (203 unique) exist at the exact referenced commits; read semantic scope/identity/blank-result distinctions. Numbered manual ID sets are 35 < 60 < 64; four last additions are G15.1–G15.4. Documentation validation, not protocol execution.
- Corrected CN retains eight result blocks and separate PQ-009 requirement; CU retains six result blocks and 146 stop. Safe scoped logs/source-check output are in docs/signoff/review-evidence/. No assertions weakened.
- `git diff --check` passes on every deliverable. Published trees are compared with local committed trees before completion. GitHub API is used for commit/tree/ref publication because HTTPS git credential access was unavailable; no credentials printed.

## Unfilled decisions and actual work still needed

John/Rhys agree G14's actual decision time from measured restore duration, not a guessed promise. Complete C8's real contact/deputy names/numbers and test them privately. John fills F6, AI sharing choices, number choice and paid-time choice; accountant completes D7's entity-specific retention/holds and any payroll/numbering advice. No decision, signature, private phone or account identity has been fabricated.

B13 is Monday 2–Friday 6 November, the build/test week. The plan explicitly says past Monday/Tuesday are not evidence; schedule missed rows before Friday or mark NOT READY. It covers offline tablet/queued work/paper, Marpet protection and independently checked opening balances. Automated tests stay on a separate fake-only backend, not the restored real-data manual copy.

B15/B17 are instructions only: prove replacement/cover admins and membership scope; remove primary/secondary/alternate elevated access safely; verify enrolment, company DB rule and Production deployment switch. No account or security setting changed here. Live SQL remains separately controlled and was not run.

Domain comes first for all three app registrations. Xero uses stored Platform App connections or the explicit env fallback; Sage/QBO use their actual server env names. Current scope/consent and portal terms/cost/free-test eligibility must be checked by Rhys; we did not browse/register an account or promise free live access. Do not buy upgrades as a workaround. Sage/QBO adapters check balances and do not export invoices. Provider consent is broader than an app read-only promise; accept the real grant or leave the provider off.

All drafts remain unsigned, unexecuted operational forms. Actual portal/manual/payroll/contact/restore/database/provider/browser checks are NOT RUN. Build/test deadline Friday 6 November; conditional go-live Thursday 12 November. **146 cannot be re-applied after rollback; restore from a verified backup is the only route to the required state.** No deletion of retained history or guard weakening. No main merge, deployment, production SQL, live email, real account change, registration or purchase. Independent final-candidate review and actual protocol/operations sign-off remain required.

## Usage-reset continuation

Rechecked all thirteen published draft trees against the local committed trees: matching; they had already been published before the usage stop. The new CR–CV/BA review is appended to BUILDER-3-CROSS-REVIEW.md. CR–CU heads unchanged. CV's e7581c43b5f92836ceaedcf2716d495392a9d9e6 branch exists without a PR or measured-results report; only the exact sibling-guide additions were reviewed. BA #269 source-summary/release-scope corrections are in tests/reviews/BA-269-SOURCE-CORRECTIONS.md; the current complete go/no-go register is preserved. No new runtime evidence claimed. CW and CX have separate explicit claims/drafts; their later handover carries the final packet inventory.

CV subsequently opened as #315 at 727ff228b6bc8575bc4440f409fdd3c41fe4ce5e. The continuation review now checks its reported 5,622/415 candidate and 5,357/373 CM unit results against complete committed file inventories and successful log hashes; no fresh runtime/approval claim. Earlier branch-only wording is historical. See the review report and CV-315-SOURCE-CHECK.txt.

New BA #317 at 9515eda33b50878a057a431b06498a5b1f15b204 was also reviewed. Its full 41-row ledger is carried with only four company-details source anchors corrected from the year-end ZIP section to CompanyDetailsCard. All rows remain NOT TESTED/MISSING pack proof. No original owner branch changed.
