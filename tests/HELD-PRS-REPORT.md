# Held PR report for Rhys

READ-ONLY REPORT. No PR was closed, rebased, labelled, made ready, merged or changed by AP. These are recommendations for Rhys, not actions or release/SQL approval. Checked 3 November 2026 against final reviewed #247 **fe7514fbea7eaac2fead0237db0fa7d2abcc6db8**, not a moving main branch.

Assumption: "other open non-draft old PR" means every open non-draft PR returned by GitHub, regardless of age. All five such PRs were #11, #30, #84, #194 and #225; #225 is included for completeness. The named held list also includes drafts and already-merged #201. API pagination was used. A later new PR/head requires a fresh check.

Inclusion uses exact-head ancestry first, then patch-equivalence and current tree/path inspection where not ancestral. Similar filenames or shared ideas do not count as full inclusion. Exact ancestry establishes code history, not passed CI, SQL approval or software validation. No tests were rerun for this report.

| PR / observed state | What it does | Already inside #247? | One-line risk | Recommendation for Rhys |
| --- | --- | --- | --- | --- |
| [#11](https://github.com/rhyshume1997-alt/tolra-public/pull/11) / open non-draft | Proposes four browser shards, one DB/upgrade job and a ci-gate depending on them. | No complete inclusion: final #247 still has one integration job and no four-shard browser matrix; its workflow differs. | A failed/cancelled shard or targeted run could incorrectly satisfy protection unless all gating conditions are proved. | **keep**. Remain held until failed/cancelled-shard gating, branch rules/targeted-run exclusion and exact-head DB/all-shard evidence are reviewed. |
| [#30](https://github.com/rhyshume1997-alt/tolra-public/pull/30) / open non-draft | Adds PRODUCT.md, DESIGN.md and .impeccable/design.json product/design context without app code. | No: all three files are absent from final #247. | Old design/context instructions may mislead later UI work if treated as current product requirements. | **rebase**. Refresh context against the shipped product and have Rhys review it separately from release approval. |
| [#84](https://github.com/rhyshume1997-alt/tolra-public/pull/84) / open non-draft | Provides S1 two-company RLS proof, S2 API/page role matrix, S3 mail/header/bundle guards and S4 CSRF proofs. | Not fully included: head is not an ancestor and key files are missing, including lib/mail-header.ts, rls-two-tenant-proof, api-role-matrix and csrf-origin tests. Some guard concepts overlap newer code; that is not complete inclusion. | The named security proofs remain missing, while an old route matrix may omit newer endpoints. | **rebase**. Keep every assertion, update the route inventory against final code and separate old docs changes from any future code PR. |
| [#161](https://github.com/rhyshume1997-alt/tolra-public/pull/161) / open draft | Adds the code-only chase browser line and local runner, including later reviewed-text follow-ups. | Yes by ancestry: the exact PR head is reachable from final #247. | Merging the old line again adds no missing proof and can confuse the final evidence trail. | **close as superseded**. Only Rhys closes it; retain its audit/history links and require actual browser evidence on final code. |
| [#194](https://github.com/rhyshume1997-alt/tolra-public/pull/194) / open non-draft | Simplifies 14 shop-facing wording occurrences and updates exact wording assertions. | Not fully included: head is not an ancestor, no unmatched commit is patch-equivalent, and all 11 affected paths differ. N6 has also replaced parts of the older template UI. | Blindly carrying older text/UI can overwrite newer editor wording or leave selectors out of step. | **rebase**. Reapply only still-relevant wording to the final candidate, preserving all assertions and the N6 editor. |
| [#197](https://github.com/rhyshume1997-alt/tolra-public/pull/197) / open draft | Makes plain /login neutral despite remembered cookie/local storage; explicit company links still brand. | No: the candidate still reads BRAND_COOKIE in app/login/page.tsx and calls useRememberBrand in the shell; the held change removes those paths. | The candidate can still show remembered company branding on plain login; integration must retain the newer N5 setup guide. | **rebase**. Keep the neutral-login/browser assertions and retain the current dashboard-shell setup guide. |
| [#201](https://github.com/rhyshume1997-alt/tolra-public/pull/201) / merged/closed | Proves duplicate customer names across pages one and three prevent both automatic and fixed-recipient chase drafts. | Yes by ancestry: exact merged head is reachable from final #247. | Calling an already merged PR held can cause duplicate work or mistaken extra merge approval. | **keep**. Already merged/closed. Keep the history; no close, rebase or second merge action is needed. |
| [#202](https://github.com/rhyshume1997-alt/tolra-public/pull/202) / open draft | Adds costing-143 atomic save DB rehearsal, a guarded disposable fixture and its ten DB assertions. | No complete inclusion: costing 143, its engine/rates files and DB tests are absent. Only the costing atomic SQL proposal matches byte-for-byte. | Installing or merging this would introduce the explicitly excluded costing-143 dependency and a separate SQL decision. | **keep**. Hold outside this release; do not fold it into chase phase 147 or pretend the proposal alone is the feature. |
| [#207](https://github.com/rhyshume1997-alt/tolra-public/pull/207) / open draft | Combines reviewed chase sends/recovery and UI coverage on the #161 line; its atomic save proposal still needs release proof. | Yes for existing code/proposal by ancestry; AO phase 147 packaging is a separate new draft, not inside final fe7514f. | The application calls an atomic settings RPC whose production release/race/rollback evidence is still held. | **keep**. Hold until AO release packaging and the 14-item real DB evidence are reviewed; do not merge this old line again. |
| [#225](https://github.com/rhyshume1997-alt/tolra-public/pull/225) / open non-draft | Adds the requested Website by Rhys Hume public-footer credit linking to his websites page. | No: WEB_CREDIT and the footer credit link are absent from final #247. | A small public-facing change still needs Rhys to confirm its copy/link and the current footer layout. | **rebase**. A narrow rebase onto the final marketing footer is safer than replacing its older file wholesale. |

## Pinned inspected heads

| PR | Head | Source branch |
| --- | --- | --- |
| #11 | `f92d4d882f440517958f7a02d227dce9b61f6ad3` | `claude/tolra-a10-ci-shard` |
| #30 | `ededf846ae240e32aacdd799ce4da8238c4c6908` | `design/impeccable-product-context` |
| #84 | `4765566e14c297da258fd440745af161b234b8bd` | `claude/pr48-final` |
| #161 | `d5bcebc34ab60e8f9f08f0210e44c6ddd4710665` | `chatgpt2/e2e-chasing-code-only` |
| #194 | `3d91a5014e5bc4f25516ddd92b196e836f360db9` | `codex2/wording-pass-2` |
| #197 | `817b6da88d6b6404f22ffa28dcf0bed2e8fda626` | `codex/neutral-login` |
| #201 | `ccad65bcd30ec6bae8acfc4fd1b01731b1eadb26` | `codex/chase-draft-pages` |
| #202 | `6431e60284a4591ab6c9552de5bc0dd0468973f3` | `codex/costing-sql-test-plan` |
| #207 | `8a7daaedebc03c5640bc214c49c2089702998a46` | `codex/chase-combined` |
| #225 | `345d3fb8de76561343dead4e64c5e3d3f25acf66` | `design/footer-credit` |

## Checks behind the recommendations

- #161, #201 and #207: `git merge-base --is-ancestor <head> fe7514f` succeeded for each exact fetched head.
- #197: current candidate app/login/page.tsx still imports/reads cookies and BRAND_COOKIE, and dashboard-shell still remembers branding. Its neutral-login patch is not already shipped in this candidate.
- #84: no full ancestry/patch-equivalence inclusion; several specifically named proof/header files are absent. This is a missing proof line, not a claim that every corresponding runtime guard is broken.
- #202: the costing atomic proposal is present, but supabase/migrations/143_costing_rates.sql, release/verify files and costing engine/rates DB suites are absent. Costing atomic settings stays out because 143 is absent.
- #11: the current candidate workflow uses integration and ci-gate; the PR's four-browser-shard topology is not present. Do not change branch protection from this report.
- #194/#225: current source/patch inspection does not establish full inclusion. Rebase only if Rhys still wants the residual wording/credit changes.

Full CI/reviewer/runtime conditions remain separate, including #207's atomic settings package/proof. AO is a separate draft into #247, not evidence that final fe7514f already contains release 147. #250 wipe stays NOT SAFE pending the real combined-kit throwaway rehearsal. SAFE WITH CONDITIONS never means release approval.

- [x] AP: every named held PR plus every observed open non-draft PR inspected and recorded.
- [ ] Rhys: decide close as superseded, rebase or keep for each row; no decision/action was performed here.
