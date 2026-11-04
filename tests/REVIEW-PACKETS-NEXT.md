# Next review packets, builder 3

Snapshot: 4 November 2026, 148 open PRs from both GitHub API pages. This extends the former 11-packet subset so every open PR has a paste-ready packet; older packets may also exist. Metadata collection only: no broad code audit or suite rerun. No PR besides the assigned job/reporting branches is changed.

CI fields below are actual pull-request-triggered runs returned for the full snapshot head. No run means no matching PR-triggered run was returned, not proof that no manual/push run exists. Queued/in-progress has no passing conclusion. Recheck run state and head before review; inherited/local counts are not promoted to CI. Build/test deadline Friday 6 November; go-live target Thursday 12 November 2026.

CQ refreshes #281–#284 to the exact reviewed source heads and CI conclusions below. The original 148-PR inventory is historical; this is not a new all-PR audit. CQ’s own resulting head and checks belong in tests/CQ-REVIEW-281-284.md and the coordination handover after commit. Refresh any moved packet from that companion before use. Draft status and evidence are not a SAFE verdict, merge authority or production SQL approval.

## PR #284: CL: penny half-up rule and unchanged costing rounding exceptions

Review https://github.com/rhyshume1997-alt/tolra-public/pull/284 at head `d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d` (base `codex/ch-review-packets-next`). CI run ID: [41826433316](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826433316) CI: completed, conclusion failure.

Check: Check tests/ROUNDING-RULE.md and the existing app/real-PostgreSQL parity tests: 0.135 becomes 0.14, ties stay half-up for normal money and VAT rounds per line. Preserve costing half-to-even and all 60 golden answers. Real DB execution remains NOT TESTED. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #283: CH: priority review packets with exact heads and remaining work

Review https://github.com/rhyshume1997-alt/tolra-public/pull/283 at head `e40f9edb24a79769efd03b8f900c6c31d8a6729b` (base `codex/cg-ck-evidence`). CI run ID: [41826384400](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826384400) CI: completed, conclusion success.

Check: Compare all open PRs, exact snapshot heads and CI run IDs; refresh moved heads. Packets convey no review verdict. Use the final builder-3 handover for this reporting PR’s resulting head. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #282: CG CK: named AI and accounting evidence with untested conditions

Review https://github.com/rhyshume1997-alt/tolra-public/pull/282 at head `b80b274b0f2b8b12444915152383564cc1b9bf52` (base `codex/cj-acceptance-specs`). CI run ID: [41826333766](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826333766) CI: completed, conclusion success.

Check: Check every available gate/manual/CW/validation row names a proving file; inspect N2 key/cap/MFA and N3 provider isolation gaps. Missing Operations Pack and unrun final-head results must keep NO GO. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #281: CJ: named fail-closed N1 N5 N6 browser acceptance specs

Review https://github.com/rhyshume1997-alt/tolra-public/pull/281 at head `ff29ca191879ec954e305ec0eb200501789a5bcf` (base `codex/ci-branch-checks`). CI run ID: [41825174221](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41825174221) CI: completed, conclusion failure.

Check: Run the three N1/N5/N6 specs on the verified disposable backend; compare planned and actual paid hours, blank-company isolation and both template editors. Read tests/CJ-BUILDER-3-RESULTS.md: setup failure is not runtime proof. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #280: CI: exact-head branch audit and failed-command release refusals

Review https://github.com/rhyshume1997-alt/tolra-public/pull/280 at head `f4eacee2236e65e52fdccbdf5cf8f8045fd95d80` (base `codex/ch-review-packets`). CI run ID: [41821065069](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41821065069) CI: completed, conclusion failure.

Check: Check the stopped audit remains 52/61; inspect the command-exit/collection-error refusal fix and all mandatory Operations Pack/wipe gate groups in scripts/release-gate/. Do not restart the broad audit or treat synthetic gate tests as runtime evidence. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #279: CH: exact-head review packets and explicit missing proofs

Review https://github.com/rhyshume1997-alt/tolra-public/pull/279 at head `4bb59c0ecfda0a545ec7221ef569dcc1184418db` (base `codex/cg-go-no-go-evidence`). CI run ID: [41813309228](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41813309228) CI: completed, conclusion success.

Check: Check the historical exact-head packet links, scoped counts and missing proofs; this earlier packet set is superseded by the later #283 snapshot. Documentation is not a runtime pass or review verdict. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #278: CG: explicit go/no-go evidence with every unproved gate visible

Review https://github.com/rhyshume1997-alt/tolra-public/pull/278 at head `8d667ffc7d779d4487fcf19eb052b123ec98baa8` (base `codex/cf-db-day-runbook`). CI run ID: [41812946899](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41812946899) CI: completed, conclusion success.

Check: Check the historical go/no-go register accounts for the available gate/manual/validation/CW items and states the missing Operations Pack. Use #282 for later file-path/N2/N3 mappings; retain all unproved runtime gates. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #277: CF: plain-English database-day runbook with mandatory stop gates

Review https://github.com/rhyshume1997-alt/tolra-public/pull/277 at head `87c4bbf52b895c1e618d32205e5023adb4d60cbc` (base `codex/ce-validation-final`). CI run ID: [41812612560](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41812612560) CI: completed, conclusion success.

Check: Check tests/GO-LIVE-DB-RUNBOOK.md release order, each stop gate, actual backup/restore/wipe/import evidence requirements and the stop after 146 rollback. The runbook performs no SQL and grants no operational approval. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #276: CE: refresh validation pack with scoped evidence and untested rows

Review https://github.com/rhyshume1997-alt/tolra-public/pull/276 at head `e71a80072148077a4c0f05184fe40d79688c01ee` (base `codex/cd-sliq-no-write`). CI run ID: [41812171315](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41812171315) CI: completed, conclusion failure.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #275: CD: fake-only SliQ dry run with no write entry point

Review https://github.com/rhyshume1997-alt/tolra-public/pull/275 at head `d73bb240a23b38a7080c0933e4f5b62ddd529f5f` (base `codex/cc-jnr-reconcile`). CI run ID: [41811642750](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41811642750) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #274: CC: read-only JNR import and preservation reconciliation

Review https://github.com/rhyshume1997-alt/tolra-public/pull/274 at head `d88f06333556e5c2a80e183a5067c5f7117562fa` (base `codex/cb-release-gate`). CI run ID: [41811157505](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41811157505) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #273: CB: Add fail-closed final-commit release gate

Review https://github.com/rhyshume1997-alt/tolra-public/pull/273 at head `ff13614fcd8bd37d989faec74d387371ef7ac378` (base `codex/ca-sliq-releases`). CI run ID: [41810525853](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41810525853) CI: completed, conclusion failure.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #272: CA: required SliQ release packages

Review https://github.com/rhyshume1997-alt/tolra-public/pull/272 at head `ef3e76e3e6c0fdbc012a4f59bd55dddd2f26920b` (base `codex/x-final-main-candidate`). CI run ID: [41809614895](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41809614895) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #271: Coordinate explicit CA-CI handoff and job evidence

Review https://github.com/rhyshume1997-alt/tolra-public/pull/271 at head `f42cbbf23fdbd28fbf8c3d9e0a91cd3fb6bd6563` (base `codex/work-ownership`). CI run ID: [41823372416](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41823372416) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #270: BB: fake two-company transfer generator with exact reconciliation

Review https://github.com/rhyshume1997-alt/tolra-public/pull/270 at head `4f210972adbffa2d5cd5c4148b1065a8df7548ef` (base `claude/sliq-import`). CI run ID: [41803304410](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41803304410) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #269: BA: explicit go/no-go evidence ledger and source coverage gaps

Review https://github.com/rhyshume1997-alt/tolra-public/pull/269 at head `89849ae3331bb6703a7d076d540843c4f63b6bc9` (base `codex/x-final-main-candidate`). CI run ID: [41802704485](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41802704485) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #268: AZ: named N1 N5 N6 browser and persisted-state acceptance

Review https://github.com/rhyshume1997-alt/tolra-public/pull/268 at head `94449be9b8a711b2f8eae96f5b30403b22296c7b` (base `codex/x-final-main-candidate`). CI run ID: [41802454373](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41802454373) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #267: AY: database day runbook with backup and stop rules

Review https://github.com/rhyshume1997-alt/tolra-public/pull/267 at head `9795ee1a8f5985dcaffb7823f9d55ded8698892d` (base `codex/x-final-main-candidate`). CI run ID: [41802000147](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41802000147) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #266: AX: pinned review packets for open Codex changes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/266 at head `4fae060450fdfaa180acb073950153a27d6a2cf0` (base `main`). CI run ID: [41803584072](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41803584072) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #265: AV: named rollback checks preserve business records or safely refuse

Review https://github.com/rhyshume1997-alt/tolra-public/pull/265 at head `fcb4e9bac74447aef90f9c2d1d1333536024c6f4` (base `codex/x-final-main-candidate`). CI run ID: [41801232365](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41801232365) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #264: AW: document JNR transfer plan and fake-only dry run

Review https://github.com/rhyshume1997-alt/tolra-public/pull/264 at head `e26fd743e5145f5d9ee56878cc3733d88d147bdf` (base `claude/sliq-import`). CI run ID: [41801123173](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41801123173) CI: completed, conclusion success.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #263: AR: align go-live manual checks with current candidate

Review https://github.com/rhyshume1997-alt/tolra-public/pull/263 at head `8cecd36e5fc852ae52e564db422f6201c8960a56` (base `codex/z-go-live-manual-checks`). CI run ID: [41785729704](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41785729704) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #262: AQ: proof-gated morning approval checklist

Review https://github.com/rhyshume1997-alt/tolra-public/pull/262 at head `6be692d3e3fde62baed099c71dc518bfbf2930a5` (base `main`). CI run ID: [41785642508](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41785642508) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #261: AQ: Write Rhys morning release and merge checklist

Review https://github.com/rhyshume1997-alt/tolra-public/pull/261 at head `14e7291070a99ee10658da2781699859310124c7` (base `codex/x-final-main-candidate`). CI run ID: [41734598204](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41734598204) CI: completed, conclusion success.

Check: Check the morning checklist preserves reviewer/Rhys decisions, correct dependency order and mandatory runtime evidence. A date, green subset or checklist does not authorise merge or production SQL. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #260: AP: Report held PR scope inclusion and risks for Rhys

Review https://github.com/rhyshume1997-alt/tolra-public/pull/260 at head `3c151ae1b58d05697f9272aa3216d4ee6ffdf087` (base `codex/x-final-main-candidate`). CI run ID: [41734328120](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41734328120) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #259: AO: Package chase atomic settings as guarded release 147

Review https://github.com/rhyshume1997-alt/tolra-public/pull/259 at head `2c9ded37e503d66cf9b96c620e98fdd86abf1302` (base `codex/x-final-main-candidate`). CI run ID: [41733908046](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41733908046) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #258: AK: Map N4 validation to the shipped candidate and save dated evidence

Review https://github.com/rhyshume1997-alt/tolra-public/pull/258 at head `349195f498338c352bead29eb6e0afd76b4f53a9` (base `codex/x-final-main-candidate`). CI run ID: [41729562730](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41729562730) CI: completed, conclusion failure.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #257: AJ: Update takeover handover and reviewer proof state

Review https://github.com/rhyshume1997-alt/tolra-public/pull/257 at head `f0a654c5ed894b14884cad4dcedc6cb3a171bccf` (base `codex/w-codex-1-handover`). CI run ID: [41730006833](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41730006833) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #256: AI: Add database reviewer proofs for #234

Review https://github.com/rhyshume1997-alt/tolra-public/pull/256 at head `d41d122fbf9f3aa9818b886e65e33b765397693a` (base `codex2/k-ai-combined-main`). CI run ID: [41715287501](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41715287501) CI: completed, conclusion failure.

Check: Check the reviewer cap and accounting-permission proofs described in tests/validation/OUTSTANDING-CHECKS.md: real PostgreSQL owner/cap/company ACLs and provider/token/OAuth isolation. Require actual execution after correct release sequencing, not unit mocks. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #254: AI: Add database reviewer proofs for #232

Review https://github.com/rhyshume1997-alt/tolra-public/pull/254 at head `8d4616f3a61f7acde8646eb3a63224997a120728` (base `codex2/i-owner-ai-caps`). CI run ID: [41715255484](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41715255484) CI: completed, conclusion failure.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #252: AI: Add database reviewer proofs for #239

Review https://github.com/rhyshume1997-alt/tolra-public/pull/252 at head `5a923801befe5ffd1514ba19938ff9090685a436` (base `codex/q-setup-access-tests`). CI run ID: [41715218532](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41715218532) CI: completed, conclusion failure.

Check: Check the independent setup reviewer conditions on #239, including support and elevated support access; require actual disposable PostgreSQL evidence for the complete role matrix. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #251: AI: Add database reviewer proofs for #236

Review https://github.com/rhyshume1997-alt/tolra-public/pull/251 at head `b8e9b3daeb9f6b07d144c57d4a453c39bf731176` (base `codex/n-company-setup-email-combined`). CI run ID: [41715198202](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41715198202) CI: completed, conclusion failure.

Check: Check the added setup reviewer permission cases on the #236 source: ordinary/read-only/support/outsider/company boundaries must run against the prepared disposable PostgreSQL schema. Do not claim paid-break/browser execution from a setup-only proof. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #250: AH: Harden reviewed wipe evidence preservation and scope checks

Review https://github.com/rhyshume1997-alt/tolra-public/pull/250 at head `7fb1656f5a990239a95109c44565b48f1ece1107` (base `codex/ac-wipe-kit-proposed-lines`). CI run ID: [41786725207](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41786725207) CI: completed, conclusion failure.

Check: Require the exact combined-driver disposable rehearsal, archive immutability/ACL and refusal proofs, complete Marpet/login/settings/numbering/audit preservation and JNR-only provider disconnect checks. Public snippets alone cannot clear the private-kit condition. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #249: test: propose wipe-kit lines with approval history retained

Review https://github.com/rhyshume1997-alt/tolra-public/pull/249 at head `f2ca4650e4032800c11d5ab65fb85e39ae0f22fd` (base `main`). CI run ID: [41710138007](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41710138007) CI: completed, conclusion failure.

Check: Require the exact combined-driver disposable rehearsal, archive immutability/ACL and refusal proofs, complete Marpet/login/settings/numbering/audit preservation and JNR-only provider disconnect checks. Public snippets alone cannot clear the private-kit condition. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #248: test: add Rhys's go-live rehearsal click checklist

Review https://github.com/rhyshume1997-alt/tolra-public/pull/248 at head `a38ffd683c370788fa1c3d98a324081c08d37950` (base `main`). CI run ID: [41703880819](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41703880819) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #247: Combine final main rehearsal candidate: chasing, setup, accounting, AI and fonts

Review https://github.com/rhyshume1997-alt/tolra-public/pull/247 at head `41c685c416305637d86b580324fff9e6cda037ff` (base `main`). CI run ID: [41736552876](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41736552876) CI: completed, conclusion failure.

Check: Check the complete combined candidate: chase exact-text/recovery, N1/N5/N6, accounting, AI/caps and local fonts, plus required release packaging and the current included/excluded inventory. Require actual final-head runtime/rehearsal proofs and independent review. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #246: test: hand over Codex PRs and remaining validation

Review https://github.com/rhyshume1997-alt/tolra-public/pull/246 at head `d5ab1c7edbb72e33cd032f9a65860a95e4229160` (base `main`). CI run ID: [41707827461](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41707827461) CI: completed, conclusion success.

Check: Check the handover inventory, exact source heads, completed versus blocked work and next commands; retain historical evidence scopes. No code-safety or runtime result follows from a handover edit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #245: V: Add reviewer Playwright cases and matching click checks

Review https://github.com/rhyshume1997-alt/tolra-public/pull/245 at head `2b4bd18390efc468a01b449dae70c844ee204a05` (base `codex/x-final-main-candidate`). CI run ID: [41710831188](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41710831188) CI: completed, conclusion failure; [41709377847](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41709377847) CI: completed, conclusion failure; [41709375585](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41709375585) CI: completed, conclusion cancelled.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #244: U: Add explicit local-only Tolra Demo seed

Review https://github.com/rhyshume1997-alt/tolra-public/pull/244 at head `537b3ea4ede00702bb853aadb492e013af38a797` (base `main`). CI run ID: [41695577907](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41695577907) CI: completed, conclusion failure.

Check: Check synthetic data only, loopback/disposable identity and refusal of hosted or real-company targets. Verify counts, cleanup boundaries and no real delivery; a plan or generator is not execution evidence. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #243: JOB U: demo-data seed for a throwaway database ("Tolra Demo")

Review https://github.com/rhyshume1997-alt/tolra-public/pull/243 at head `15020e5d20afe27cb48847c310ccf39ff1c99da8` (base `main`). CI run ID: [41709008255](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41709008255) CI: completed, conclusion success.

Check: Check synthetic data only, loopback/disposable identity and refusal of hosted or real-company targets. Verify counts, cleanup boundaries and no real delivery; a plan or generator is not execution evidence. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #242: T: Build marketing fonts from local assets

Review https://github.com/rhyshume1997-alt/tolra-public/pull/242 at head `25b792572c7a5df0e141fdbc91cdd54afa46daa8` (base `main`). CI run ID: [41695080863](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41695080863) CI: completed, conclusion failure.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #241: S: Prove inbound payment wording stays evidence only

Review https://github.com/rhyshume1997-alt/tolra-public/pull/241 at head `f96087a58bf7dd9030e447e71a10b52ba54671d9` (base `codex2/j-chasing-combined-main`). CI run ID: [41801461611](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41801461611) CI: completed, conclusion success.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #240: Q: Prove cross-company accounting reads stay isolated

Review https://github.com/rhyshume1997-alt/tolra-public/pull/240 at head `3692debaa9a724762f230412eff17aa911a85ba2` (base `codex/o-accounting-combined`). CI run ID: [41715390074](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41715390074) CI: completed, conclusion success; [41713082355](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41713082355) CI: completed, conclusion failure; [41695640741](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41695640741) CI: completed, conclusion failure; [41680866846](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41680866846) CI: completed, conclusion failure.

Check: Check Xero/Sage/QuickBooks credentials/results stay separate, tokens remain encrypted/private and company/admin/MFA boundaries hold. Missing registration refuses; connecting or provider evidence must never mark invoices paid. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #239: Q: Cover ordinary and support access to setup progress

Review https://github.com/rhyshume1997-alt/tolra-public/pull/239 at head `1226c15f168ae4c77b27412e96d8d2cb06763da5` (base `codex/n-company-setup-email-combined`). CI run ID: [41695645972](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41695645972) CI: completed, conclusion failure; [41680692377](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41680692377) CI: completed, conclusion failure.

Check: Check blank business lists, own-admin-only setup persistence and ordinary/read-only/support denial. In both email editors verify detail buttons, live preview without mail, legacy text preservation and company isolation. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #237: O: Combine accounting adapters and encrypted isolation proofs

Review https://github.com/rhyshume1997-alt/tolra-public/pull/237 at head `86eda4bd48b1237b42140dbd72ace7cb73442f4b` (base `main`). CI run ID: [41700473717](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41700473717) CI: completed, conclusion success.

Check: Check Xero/Sage/QuickBooks credentials/results stay separate, tokens remain encrypted/private and company/admin/MFA boundaries hold. Missing registration refuses; connecting or provider evidence must never mark invoices paid. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #236: N: Combine company breaks, blank setup and email editor

Review https://github.com/rhyshume1997-alt/tolra-public/pull/236 at head `d54d90b0408fbd490f03ada687b27af03bba9800` (base `main`). CI run ID: [41693048362](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41693048362) CI: completed, conclusion failure.

Check: Check the combined paid-break, blank-company setup and both email-editor changes retain their source assertions and company/role boundaries. Require actual N1/N5/N6 database/browser results; a unit suite alone does not complete them. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #234: K: Combine AI modes, reviewer regressions and custom caps on main

Review https://github.com/rhyshume1997-alt/tolra-public/pull/234 at head `baafb39e1ff33d11d3c5023cd764c8fcfb8f182e` (base `main`). CI run ID: [41699961037](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41699961037) CI: completed, conclusion success.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #233: J: Combine reviewed chase work and main for database/browser checks

Review https://github.com/rhyshume1997-alt/tolra-public/pull/233 at head `97811d301479d4e409b8eb89f0e7ff2bc61db7e6` (base `main`). CI run ID: [41801451701](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41801451701) CI: completed, conclusion success.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #232: I: Owner-set company AI caps with atomic reservation limits

Review https://github.com/rhyshume1997-alt/tolra-public/pull/232 at head `d5c69bd4f06c1518ccac6af965fb2df29d21cfab` (base `codex2/n2-tolra-provided-ai`). CI run ID: [41671698661](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41671698661) CI: completed, conclusion failure.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #231: design: owner and admin section, In development tag, screenshots to public/screens (N7)

Review https://github.com/rhyshume1997-alt/tolra-public/pull/231 at head `a3958d67c4525640aeb9e628f7e183195e109c0d` (base `main`). CI run ID: [41672742349](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41672742349) CI: completed, conclusion failure; [41672567583](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41672567583) CI: completed, conclusion cancelled.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #230: H3/H4: Prove encrypted accounting tokens and provider isolation

Review https://github.com/rhyshume1997-alt/tolra-public/pull/230 at head `ad1027ed7b57b73757e27c2dddd4e54fd863eb21` (base `codex/accounting-connections`). CI run ID: [41700120554](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41700120554) CI: completed, conclusion success.

Check: Check Xero/Sage/QuickBooks credentials/results stay separate, tokens remain encrypted/private and company/admin/MFA boundaries hold. Missing registration refuses; connecting or provider evidence must never mark invoices paid. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #228: H1: Prove key isolation when switching AI accounts

Review https://github.com/rhyshume1997-alt/tolra-public/pull/228 at head `65bbaecd4f23a3bddb7d85ea34fe8d6737d5a45a` (base `codex2/n2-tolra-provided-ai`). CI run ID: [41671788070](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41671788070) CI: completed, conclusion failure; [41667661217](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41667661217) CI: completed, conclusion failure.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #227: N1–N6 browser specs, manual checks and blocked database CI handoff

Review https://github.com/rhyshume1997-alt/tolra-public/pull/227 at head `d85c6527ec0459c894a1599133bd739ff117b13c` (base `main`). CI run ID: [41695673668](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41695673668) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #226: Bring the chase line up to date with main

Review https://github.com/rhyshume1997-alt/tolra-public/pull/226 at head `bfd51adfa18ff0fa801bc0d659c614200447af66` (base `chatgpt2/chase-customer-review-code-only`). CI run ID: [41674788064](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41674788064) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #225: Footer: Website by Rhys Hume credit

Review https://github.com/rhyshume1997-alt/tolra-public/pull/225 at head `345d3fb8de76561343dead4e64c5e3d3f25acf66` (base `main`). CI run ID: [41662783201](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41662783201) CI: completed, conclusion success; [41662754786](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41662754786) CI: completed, conclusion cancelled.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #224: N2: Optional Tolra-provided AI with encrypted key and company caps

Review https://github.com/rhyshume1997-alt/tolra-public/pull/224 at head `f4d7654376256fbe9c88f864b146f72eb5236188` (base `main`). CI run ID: [41671647161](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41671647161) CI: completed, conclusion failure; [41661019539](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41661019539) CI: completed, conclusion failure.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #223: N6: Plain email editor with labelled sections and detail buttons

Review https://github.com/rhyshume1997-alt/tolra-public/pull/223 at head `f1ed216f494eedf713ee5632fb38b1427d3eee9d` (base `main`). CI run ID: [41671640897](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41671640897) CI: completed, conclusion failure; [41658394090](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41658394090) CI: completed, conclusion failure.

Check: Check blank business lists, own-admin-only setup persistence and ordinary/read-only/support denial. In both email editors verify detail buttons, live preview without mail, legacy text preservation and company isolation. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #222: N5: guide blank companies through setup across existing screens

Review https://github.com/rhyshume1997-alt/tolra-public/pull/222 at head `970e918318215e7e4c5ba9a5b1e96118534965e3` (base `main`). CI run ID: [41671637468](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41671637468) CI: completed, conclusion failure; [41656543242](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41656543242) CI: completed, conclusion failure.

Check: Check blank business lists, own-admin-only setup persistence and ordinary/read-only/support denial. In both email editors verify detail buttons, live preview without mail, legacy text preservation and company isolation. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #221: Share accounting connections with Sage cloud and QuickBooks adapters

Review https://github.com/rhyshume1997-alt/tolra-public/pull/221 at head `53030fd4224c6b2451f2af386fdb9d692b0ee8fc` (base `main`). CI run ID: [41698143411](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41698143411) CI: completed, conclusion success.

Check: Check Xero/Sage/QuickBooks credentials/results stay separate, tokens remain encrypted/private and company/admin/MFA boundaries hold. Missing registration refuses; connecting or provider evidence must never mark invoices paid. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #220: Add plain-language validation pack under tests

Review https://github.com/rhyshume1997-alt/tolra-public/pull/220 at head `fb8a262060a1a33c87cbe1b548b181b78d4d6ef7` (base `main`). CI run ID: [41650914555](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41650914555) CI: completed, conclusion failure.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #219: Add the company AI switch to Integrations

Review https://github.com/rhyshume1997-alt/tolra-public/pull/219 at head `02c983894e867d43c0f7eb0edf45850d72ffc3fa` (base `main`). CI run ID: [41691000264](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41691000264) CI: completed, conclusion success.

Check: Check selected-key-only use with no fallback/leak, encrypted storage, company isolation, owner MFA and cap ACLs. Require the real two-session near-cap race and provider/browser evidence; mocks cannot clear SQL conditions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #218: Use company paid-break settings across hours screens

Review https://github.com/rhyshume1997-alt/tolra-public/pull/218 at head `cc2d3f2a89b4c32276d014fa6f2bb0cbc40d0678` (base `main`). CI run ID: [41688876182](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41688876182) CI: completed, conclusion success.

Check: Check paid/unpaid company settings agree across planned hours, actual timesheets and payroll; verify boundaries and invalid seconds. For schedules require saved-day behaviour and no duplicate or unapproved email. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #216: Integrate paid-claim and bank evidence checks without automatic payment writes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/216 at head `8eb7f3370b7024ba36b04d299088cd475906a224` (base `codex/chase-layout-main`). CI run ID: [41649039893](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41649039893) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #215: Run E13 schedule checks without a database

Review https://github.com/rhyshume1997-alt/tolra-public/pull/215 at head `1671a07d096f66821b1538eaf8778d1950b4fb49` (base `codex2/e13-more-tests`). CI run ID: [41648568689](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41648568689) CI: completed, conclusion failure.

Check: Check paid/unpaid company settings agree across planned hours, actual timesheets and payroll; verify boundaries and invalid seconds. For schedules require saved-day behaviour and no duplicate or unapproved email. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #214: Test a complete fictional SliQ export without writes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/214 at head `8b805d5098cc4fb577fc00eeb116516b0d43c67e` (base `codex2/sliq-more-tests`). CI run ID: [41648183293](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41648183293) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #213: Resolve the privacy-clean wording base conflict with main

Review https://github.com/rhyshume1997-alt/tolra-public/pull/213 at head `09dc47b23b65cb6b13028c958231a129820bf697` (base `codex/plain-english-privacy`). CI run ID: [41646855412](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646855412) CI: completed, conclusion failure.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #212: Align remaining test names with Late and the reviewed labels

Review https://github.com/rhyshume1997-alt/tolra-public/pull/212 at head `6361a12f2ba21ae5931fe2ef22ac982605127d0b` (base `codex2/wording-pass-2`). CI run ID: [41646702537](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646702537) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #211: Resolve manual checklist conflict with strict sender matching intact

Review https://github.com/rhyshume1997-alt/tolra-public/pull/211 at head `321a2a7ef560296f56e52164fe11d9ae71a4d889` (base `codex/manual-checks`). CI run ID: [41646430848](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646430848) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #210: Retain main and SliQ preflight guards when merging the shared base

Review https://github.com/rhyshume1997-alt/tolra-public/pull/210 at head `476a1af11c94cf37d657dbb06c9bea08ba5a1474` (base `claude/sliq-import`). CI run ID: [41646366991](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646366991) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #209: Retain main and costing preflight guards when merging the shared base

Review https://github.com/rhyshume1997-alt/tolra-public/pull/209 at head `c3d7cbd7f856122e9c12a6ce22a3acfd91ca43a2` (base `claude/costing-in-app`). CI run ID: [41646170670](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646170670) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #208: Resolve the combined chase settings layout conflict with main

Review https://github.com/rhyshume1997-alt/tolra-public/pull/208 at head `29c9a18165a860e665c7fb27c1c3e9b7a62bea9f` (base `codex/chase-combined`). CI run ID: [41646066769](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41646066769) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #207: Combine reviewed chase sends, recovery and UI coverage on the #161 line

Review https://github.com/rhyshume1997-alt/tolra-public/pull/207 at head `8a7daaedebc03c5640bc214c49c2089702998a46` (base `chatgpt2/e2e-chasing-code-only`). CI run ID: [41662906134](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41662906134) CI: completed, conclusion failure; [41645526409](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41645526409) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #206: Remove inherited docs from the plain English feature base

Review https://github.com/rhyshume1997-alt/tolra-public/pull/206 at head `23ca102d25b49bc3e37337ba251a01daa2096300` (base `chatgpt2/plain-english-pass`). CI run ID: [41644960385](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41644960385) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #202: Add disposable database rehearsal for atomic costing saves

Review https://github.com/rhyshume1997-alt/tolra-public/pull/202 at head `6431e60284a4591ab6c9552de5bc0dd0468973f3` (base `claude/costing-in-app`). CI run ID: [41642018718](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41642018718) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #200: Resolve chase progression conflict without allowing earlier reminders

Review https://github.com/rhyshume1997-alt/tolra-public/pull/200 at head `eea9aecc9d94facf44b84bc6d16f4a15c14201ab` (base `claude/chase-steps`). CI run ID: [41634290024](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41634290024) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #199: Recover failed chase sends and hold uncertain outcomes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/199 at head `b900aa36f5e0980a132c97f39d403b01d329b381` (base `claude/chase-steps`). CI run ID: [41637024689](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41637024689) CI: completed, conclusion failure; [41634246337](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41634246337) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #197: Keep plain login neutral regardless of remembered company

Review https://github.com/rhyshume1997-alt/tolra-public/pull/197 at head `817b6da88d6b6404f22ffa28dcf0bed2e8fda626` (base `main`). CI run ID: [41637019585](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41637019585) CI: completed, conclusion success; [41632596237](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41632596237) CI: completed, conclusion failure.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #194: copy: simplify remaining shop-facing wording

Review https://github.com/rhyshume1997-alt/tolra-public/pull/194 at head `3d91a5014e5bc4f25516ddd92b196e836f360db9` (base `main`). CI run ID: [41649363680](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41649363680) CI: completed, conclusion success.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #193: Test SliQ import boundaries and refuse numeric overflow

Review https://github.com/rhyshume1997-alt/tolra-public/pull/193 at head `b838afafa5323a9029600a285195852b35961232` (base `claude/sliq-import`). CI run ID: [41622006568](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41622006568) CI: completed, conclusion failure.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #192: Test timesheet boundaries and refuse invalid seconds

Review https://github.com/rhyshume1997-alt/tolra-public/pull/192 at head `14eedfed30a82b4a8cf83a5db00ec498a768556f` (base `claude/e13-timesheet-days`). CI run ID: [41621711966](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41621711966) CI: completed, conclusion failure.

Check: Check paid/unpaid company settings agree across planned hours, actual timesheets and payroll; verify boundaries and invalid seconds. For schedules require saved-day behaviour and no duplicate or unapproved email. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #191: Join safe chase controls, reviewed-text sends and customer matching

Review https://github.com/rhyshume1997-alt/tolra-public/pull/191 at head `03e723e158d0af28507775aef0f66e1575425e78` (base `claude/chase-steps`). CI run ID: [41618388603](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41618388603) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #190: Join costing port with exact rounding and machine labour rates

Review https://github.com/rhyshume1997-alt/tolra-public/pull/190 at head `0bf7fa4e2f96114bb707af2cd53974fa09d48770` (base `claude/costing-in-app`). CI run ID: [41617574686](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41617574686) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #186: Assemble chase UI and reviewed approval fixes; progression conflict held

Review https://github.com/rhyshume1997-alt/tolra-public/pull/186 at head `474a90f63c4625cd29a8253343cd0899aa28f1cc` (base `claude/chase-steps`). CI run ID: [41785813522](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41785813522) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #184: Join costing engine, screens and atomic settings save

Review https://github.com/rhyshume1997-alt/tolra-public/pull/184 at head `a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2` (base `claude/costing-in-app`). CI run ID: [41588801415](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41588801415) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #183: Add manual go-live checks with current sender and penny rules

Review https://github.com/rhyshume1997-alt/tolra-public/pull/183 at head `6200405e7c6d34f653a6460069738c7db71aa05c` (base `main`). CI run ID: [41587860353](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41587860353) CI: completed, conclusion success.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #180: Refuse ambiguous chase customers and preserve invoice totals after credits

Review https://github.com/rhyshume1997-alt/tolra-public/pull/180 at head `800bf2a00ccf5bd75c6cc00819329529e187ce44` (base `claude/chase-steps`). CI run ID: [41652087006](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41652087006) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #178: Record builder 2 code-only twins in a separate docs-only handover

Review https://github.com/rhyshume1997-alt/tolra-public/pull/178 at head `25c388b82f6dcb266a4f20f72f117842475c815c` (base `main`). CI run ID: [41587761086](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41587761086) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #177: Code-only twin of #158: Reconcile bank CSV quote format and reference safeguards

Review https://github.com/rhyshume1997-alt/tolra-public/pull/177 at head `a24f875e5e12ccdb41e1e2afae2df73992d73741` (base `main`). CI run ID: [41584310235](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584310235) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #176: Code-only twin of #157: Reconcile paid-claim detector and strict sender adapter without dropping coverage

Review https://github.com/rhyshume1997-alt/tolra-public/pull/176 at head `71c56fff162c72635936d86fa7d5e113a7bac6dd` (base `main`). CI run ID: [41584255674](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584255674) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #175: Code-only twin of #156: Validate actual sender mailbox before suggesting paid invoices

Review https://github.com/rhyshume1997-alt/tolra-public/pull/175 at head `356c31916101afd0776198c1fd2ed7b4752adb44` (base `chatgpt/paid-claim-adapter`). CI run ID: [41584204643](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584204643) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #174: Code-only twin of #155: Save costing wiring in one transaction and preserve machine labour rates

Review https://github.com/rhyshume1997-alt/tolra-public/pull/174 at head `e50592913574b966698f1adc6e8c94763b6904ae` (base `chatgpt/costing-wiring`). CI run ID: [41631306082](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41631306082) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #173: Code-only twin of #154: Add throwaway Postgres tests and rollback for atomic settings proposals

Review https://github.com/rhyshume1997-alt/tolra-public/pull/173 at head `968475f1a7ec1558dfcf5f1435c6b3f415318096` (base `chatgpt2/chase-approval-atomic`). CI run ID: [41584099986](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584099986) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #172: Code-only twin of #153: Claim reviewed chase drafts before sending and keep settings saves atomic

Review https://github.com/rhyshume1997-alt/tolra-public/pull/172 at head `adefac577d1ceec79fc6296d39294587b60c4013` (base `chatgpt2/chase-followup`). CI run ID: [41584051321](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584051321) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #171: Code-only twin of #147: Require matching sender evidence and finish builder 2 code follow-ups

Review https://github.com/rhyshume1997-alt/tolra-public/pull/171 at head `9d29c3b3aa129934f73c79469f3316b28d86aa66` (base `chatgpt/paid-claim-adapter`). CI run ID: [41584001125](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584001125) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #170: Code-only twin of #146: Await bank confirmations and guard references and repeated payments

Review https://github.com/rhyshume1997-alt/tolra-public/pull/170 at head `dfa8c17090790c76814c2548a54b6344a6e80323` (base `chatgpt2/bank-csv-formats`). CI run ID: [41583942106](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583942106) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #169: Code-only twin of #145: Retain machine labour rates and make costing saves atomic

Review https://github.com/rhyshume1997-alt/tolra-public/pull/169 at head `b56d38355ff30f2c330ba9daffda616e94e9f6a5` (base `chatgpt2/costing-playwright`). CI run ID: [41583891491](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583891491) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #168: Code-only twin of #144: Fix chase claim reopening reviewed-text approval and atomic save adapter

Review https://github.com/rhyshume1997-alt/tolra-public/pull/168 at head `8e34d8c30ea2c86ea16855e2cd5539c40f62a9fb` (base `chatgpt2/chase-wiring`). CI run ID: [41583834982](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583834982) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #166: Code-only twin of #139: Use plain shop-floor words for new costing chasing and bank controls

Review https://github.com/rhyshume1997-alt/tolra-public/pull/166 at head `276c56ca8b67800f28e238ae05f13861747d3c77` (base `chatgpt2/pr-review`). CI run ID: [41583713579](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583713579) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #164: Code-only twin of #137: Add 30 UK paid-claim emails and fix demonstrated detection errors

Review https://github.com/rhyshume1997-alt/tolra-public/pull/164 at head `e6022261998e6d0c3313bccef88441a81e0399af` (base `chatgpt/paid-claim`). CI run ID: [41583610206](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583610206) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #163: Code-only twin of #136: Cover six UK bank CSV layouts and fix demonstrated parsing errors

Review https://github.com/rhyshume1997-alt/tolra-public/pull/163 at head `12067894a12a30c6b838389dcd3f122e959b4cb3` (base `chatgpt/bank-matcher-more-tests`). CI run ID: [41583557431](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583557431) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #162: Code-only twin of #135: costing preview fixes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/162 at head `5a1af490588494604c79ede274129b9a4f8a8bde` (base `chatgpt/costing-wiring`). CI run ID: [41583450933](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583450933) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #161: Code-only twin of #134: Add chase screen browser coverage and optional local runner

Review https://github.com/rhyshume1997-alt/tolra-public/pull/161 at head `d5bcebc34ab60e8f9f08f0210e44c6ddd4710665` (base `chatgpt2/chase-wiring`). CI run ID: [41644655992](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41644655992) CI: completed, conclusion success.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #160: Code-only twin of #132: chase screen wiring

Review https://github.com/rhyshume1997-alt/tolra-public/pull/160 at head `b3287117bdcf95f46734b134a52e9790dbcdad61` (base `claude/chase-steps`). CI run ID: [41583225453](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41583225453) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #159: Record independent review verdicts and the atomic reconciliation fixes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/159 at head `073be753c00174fccbf4cbb3d6d1b95dde419d03` (base `main`). CI run ID: [41580046892](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41580046892) CI: completed, conclusion success.

Check: Check exact pence, source identities, duplicate/overflow refusals, WIP review, numbering and protected-company preservation. Fake/offline results do not prove a real restored-copy import; retain held and unverified rows. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #158: Reconcile bank CSV quote format and reference safeguards

Review https://github.com/rhyshume1997-alt/tolra-public/pull/158 at head `63abc9c1a648c8969289bc696b7907a097e9e138` (base `main`). CI run ID: [41579229222](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41579229222) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #157: Reconcile paid-claim detector and strict sender adapter without dropping coverage

Review https://github.com/rhyshume1997-alt/tolra-public/pull/157 at head `04598b451b019a986414e5bc92d596a5257c67fd` (base `main`). CI run ID: [41578950642](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578950642) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #156: Validate actual sender mailbox before suggesting paid invoices

Review https://github.com/rhyshume1997-alt/tolra-public/pull/156 at head `a13ff77ee1d85840f9bb37c87f5aae676a26a84a` (base `chatgpt/paid-claim-adapter`). CI run ID: [41578694180](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578694180) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #155: Save costing wiring in one transaction and preserve machine labour rates

Review https://github.com/rhyshume1997-alt/tolra-public/pull/155 at head `62692db767a7b185c0e7d14139ed3a0a53787f6a` (base `chatgpt/costing-wiring`). CI run ID: [41584630432](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41584630432) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #154: Add throwaway Postgres tests and rollback for atomic settings proposals

Review https://github.com/rhyshume1997-alt/tolra-public/pull/154 at head `e996332ee4f0f51d223e08c8277406f5c6b3f1e6` (base `chatgpt2/chase-approval-atomic`). CI run ID: [41578114989](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578114989) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #153: Claim reviewed chase drafts before sending and keep settings saves atomic

Review https://github.com/rhyshume1997-alt/tolra-public/pull/153 at head `5d6b2540f82c50fccc1789dfac9799a851a1a172` (base `chatgpt2/chase-followup`). CI run ID: [41577754413](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577754413) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #152: Complete builder 2 fixes CI conflict and merge-order handover

Review https://github.com/rhyshume1997-alt/tolra-public/pull/152 at head `ca7af7c74299df84d19951057099bf776a7064ae` (base `main`). CI run ID: [41563491881](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41563491881) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #151: List shared files and exact conflict pairs for all 33 PRs

Review https://github.com/rhyshume1997-alt/tolra-public/pull/151 at head `84ebc01ed8b5fe5ef9c5b84d1e71c8f08ed0a391` (base `chatgpt2/merge-order`). CI run ID: [41563048407](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41563048407) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #150: Document the dependency order for PRs 107 to 143

Review https://github.com/rhyshume1997-alt/tolra-public/pull/150 at head `55446ac9e66b338634d28b0ff8d1d2e18fa28c08` (base `main`). CI run ID: [41562733286](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562733286) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #149: Record and resolve builder 2 conflicts with main

Review https://github.com/rhyshume1997-alt/tolra-public/pull/149 at head `76b6eec6b4d7e0fcd7dd951f07bebc40672d7f78` (base `main`). CI run ID: [41562305890](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562305890) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #148: Record exact latest web CI results for builder 2 PRs 132 to 143

Review https://github.com/rhyshume1997-alt/tolra-public/pull/148 at head `6eb787054058876f5de451994ab0aee1495a91c5` (base `main`). CI run ID: [41561329364](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561329364) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #147: Require matching sender evidence and finish builder 2 code follow-ups

Review https://github.com/rhyshume1997-alt/tolra-public/pull/147 at head `190b440a330d79ce28702b89d0659d63ed8424e1` (base `chatgpt/paid-claim-adapter`). CI run ID: [41561091473](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561091473) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #146: Await bank confirmations and guard references and repeated payments

Review https://github.com/rhyshume1997-alt/tolra-public/pull/146 at head `8142d8d0ba67e36363dd780b9ac225e191451ce5` (base `chatgpt2/bank-csv-formats`). CI run ID: [41560741748](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41560741748) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #145: Retain machine labour rates and make costing saves atomic

Review https://github.com/rhyshume1997-alt/tolra-public/pull/145 at head `b186177bf15cc7a2ddd8c23f57c16d07312746c3` (base `chatgpt2/costing-playwright`). CI run ID: [41562492803](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562492803) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #144: Fix chase claim reopening reviewed-text approval and atomic save adapter

Review https://github.com/rhyshume1997-alt/tolra-public/pull/144 at head `0cceccd5e4bf70cad740c8b30dfb65ca3a113465` (base `chatgpt2/chase-wiring`). CI run ID: [41559485830](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41559485830) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #143: Complete builder 2 ownership tracker and integration handover

Review https://github.com/rhyshume1997-alt/tolra-public/pull/143 at head `60250211e24589ec984213c05dbd0611e97b4853` (base `main`). CI run ID: [41549887794](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549887794) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #142: Record blocked whole-suite matrix with exact commits and failure evidence

Review https://github.com/rhyshume1997-alt/tolra-public/pull/142 at head `dfcb5e4a99d032e8b6e46db968e999610a3ae01f` (base `main`). CI run ID: [41549570480](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41549570480) CI: completed, conclusion success.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #140: Add costing settings and quote pricing Playwright smoke specs

Review https://github.com/rhyshume1997-alt/tolra-public/pull/140 at head `e9d9f6735726e18c8458702db965d1bf2387e6a6` (base `chatgpt2/plain-english-pass`). CI run ID: [41562450146](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41562450146) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #139: Use plain shop-floor words for new costing chasing and bank controls

Review https://github.com/rhyshume1997-alt/tolra-public/pull/139 at head `398636987136f3362757558c185b7c3b57fa3dd2` (base `chatgpt2/pr-review`). CI run ID: [41631298741](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41631298741) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #138: Cover receivables and pence boundaries and reject invalid overdue dates

Review https://github.com/rhyshume1997-alt/tolra-public/pull/138 at head `77643f52a8232da3b60268e39c898580a99b96fd` (base `main`). CI run ID: [41547277244](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547277244) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #137: Add 30 UK paid-claim emails and fix demonstrated detection errors

Review https://github.com/rhyshume1997-alt/tolra-public/pull/137 at head `3b9713c3bb52423770bc138a156906ddf994f66c` (base `chatgpt/paid-claim`). CI run ID: [41547046715](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41547046715) CI: completed, conclusion failure.

Check: Check strict sender/company matching, ambiguous-customer refusal and evidence-only paid phrases. Verify status, amount paid and balance never change automatically; retain exact approved-text and role boundaries. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #136: Cover six UK bank CSV layouts and fix demonstrated parsing errors

Review https://github.com/rhyshume1997-alt/tolra-public/pull/136 at head `6c8c7c81b908dbbd8d387262567866c7ae4e2e92` (base `chatgpt/bank-matcher-more-tests`). CI run ID: [41546655592](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41546655592) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #135: Review open Tolra PRs and fix costing preview failures

Review https://github.com/rhyshume1997-alt/tolra-public/pull/135 at head `ed23f6f3ec506210b3449f0e19f9ff34473c81f1` (base `chatgpt/costing-wiring`). CI run ID: [41561855995](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41561855995) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #134: Add chase screen browser coverage and optional local runner

Review https://github.com/rhyshume1997-alt/tolra-public/pull/134 at head `718baa8b245655ce8e14e00d2f2c416a0adee994` (base `chatgpt2/chase-wiring`). CI run ID: [41545680813](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545680813) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #133: Add JNR go-live day checklist for Thursday 12 November

Review https://github.com/rhyshume1997-alt/tolra-public/pull/133 at head `fa2c266778630929f2872b5178f8efc20afe0d1b` (base `main`). CI run ID: [41545263154](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41545263154) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #132: Wire chase cards into settings approvals and invoice pages

Review https://github.com/rhyshume1997-alt/tolra-public/pull/132 at head `9f08f96dd52cfd9cbffdde913b83a0c9286d32a8` (base `claude/chase-steps`). CI run ID: [41544971372](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41544971372) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #131: Reject bank statements containing unclosed CSV quotes

Review https://github.com/rhyshume1997-alt/tolra-public/pull/131 at head `0a6b970ababe6b5c8e0f449084e1e81159fa68dd` (base `chatgpt/bank-matcher-more-tests`). CI run ID: [41587787672](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41587787672) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #130: Establish shared ownership tracker and Codex verification handover

Review https://github.com/rhyshume1997-alt/tolra-public/pull/130 at head `b6db532209e1cea1bfcf1533a09b4c668124401d` (base `main`). CI run ID: [41803437182](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41803437182) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #125: Plain JNR wipe and go live guide

Review https://github.com/rhyshume1997-alt/tolra-public/pull/125 at head `88ebf7811f091d18e2524ed0598567f74f8b934f` (base `main`). CI run ID: [41539803751](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41539803751) CI: completed, conclusion success.

Check: Require the exact combined-driver disposable rehearsal, archive immutability/ACL and refusal proofs, complete Marpet/login/settings/numbering/audit preservation and JNR-only provider disconnect checks. Public snippets alone cannot clear the private-kit condition. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #124: ChatGPT builder one handover and review checklist

Review https://github.com/rhyshume1997-alt/tolra-public/pull/124 at head `a18146010dc3b57d7a6ee9b1006c7c3e070fcfd3` (base `main`). CI run ID: [41540331061](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41540331061) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #123: Wire company costing rates and quote pricing to live screens

Review https://github.com/rhyshume1997-alt/tolra-public/pull/123 at head `ad515217a4fa033319e368d9b46cd0b98e078c1f` (base `claude/costing-in-app`). CI run ID: [41539952009](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41539952009) CI: completed, conclusion failure.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #118: Polish invoice chase reminder wording

Review https://github.com/rhyshume1997-alt/tolra-public/pull/118 at head `897eacdb435bbc7d64f559e679b860985ebda23f` (base `main`). CI run ID: [41531779566](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41531779566) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #117: Suggest paid invoices from incoming customer emails

Review https://github.com/rhyshume1997-alt/tolra-public/pull/117 at head `79563720f49a0fe3e733c02ad9734dd38f124a3c` (base `main`). CI run ID: [41531721121](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41531721121) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #116: Bank statement confirmation screen

Review https://github.com/rhyshume1997-alt/tolra-public/pull/116 at head `d2ddea3c3872e0b7931e43a34d9164c7a02ed283` (base `main`). CI run ID: [41531638893](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41531638893) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #115: Add simple staff walkthrough for chasing, timesheet emails and costing

Review https://github.com/rhyshume1997-alt/tolra-public/pull/115 at head `40747158fbd5ae53a7e03ca1c379803fcd0b9d5b` (base `main`). CI run ID: [41528052845](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41528052845) CI: completed, conclusion success.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #113: Add customer says paid invoice controls

Review https://github.com/rhyshume1997-alt/tolra-public/pull/113 at head `3c386f5fdc8cfb79a4ee7d546901a41a3aaa6166` (base `main`). CI run ID: [41527224046](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41527224046) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #112: Add chase email approval card

Review https://github.com/rhyshume1997-alt/tolra-public/pull/112 at head `0e6fede2537ac9fb79347eb171345f625c26c0ea` (base `main`). CI run ID: [41526862162](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41526862162) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #110: Port Python costing calculations into Tolra TypeScript

Review https://github.com/rhyshume1997-alt/tolra-public/pull/110 at head `7ab51a6cfd813619b3441e71ae2ca4d388e6f492` (base `main`). CI run ID: [41577301253](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577301253) CI: completed, conclusion success.

Check: Keep half-to-even costing and 60 frozen golden answers; check machine-specific labour rates and atomic settings/refusal behaviour. Missing engine, skips or type failures remain visible; require disposable SQL proof separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #109: Add bank statement parsing and invoice matching

Review https://github.com/rhyshume1997-alt/tolra-public/pull/109 at head `c547757a3cf3c4c7a4c729d4af6b4a44e12534e0` (base `main`). CI run ID: [41577297912](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577297912) CI: completed, conclusion failure.

Check: Check quoted CSV formats, references, ambiguous matches, duplicate imports and repeated-payment refusal. Compare exact pence and await confirmation before local state changes; require database financial invariants separately. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #108: Add invoice chase scheduling and message rendering

Review https://github.com/rhyshume1997-alt/tolra-public/pull/108 at head `2bd857ba4a8e78e4cfcaa9d50dfe3ba18c703f70` (base `main`). CI run ID: [41577290404](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577290404) CI: completed, conclusion failure.

Check: Check exact approved text, edit invalidation, company/role gates, duplicate-send refusal and uncertain-delivery no automatic resend. Require guarded disposable SQL/browser evidence and preserve existing assertions. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #107: Add paid claim detection with unit coverage

Review https://github.com/rhyshume1997-alt/tolra-public/pull/107 at head `0944385a1e90a31cf5b35331c03acb44be766495` (base `main`). CI run ID: [41521786846](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41521786846) CI: completed, conclusion failure.

Check: Review the PR’s stated scope and changed files against its base; retain existing assertions and role/company boundaries. Require actual exact-head check results, record unresolved conditions and avoid treating inherited evidence as a current pass. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #84: Security proofs S1-S4 with the full role matrix (supersedes #48)

Review https://github.com/rhyshume1997-alt/tolra-public/pull/84 at head `4765566e14c297da258fd440745af161b234b8bd` (base `main`). CI run ID: [41281062515](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41281062515) CI: completed, conclusion success; [41281053666](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41281053666) CI: completed, conclusion cancelled.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #30: Add Impeccable product and design context

Review https://github.com/rhyshume1997-alt/tolra-public/pull/30 at head `ededf846ae240e32aacdd799ce4da8238c4c6908` (base `main`). CI run ID: [40682728055](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/40682728055) CI: completed, conclusion failure.

Check: Check changed user-facing text/screens at phone and desktop widths; preserve actions, permissions and sender/payment meaning. Compare relevant tests and actual build evidence at this head; do not infer runtime from old logs. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.

## PR #11: CI: browser suite in 4 shards, DB suite once (A10). Proving run only, DO NOT MERGE yet

Review https://github.com/rhyshume1997-alt/tolra-public/pull/11 at head `f92d4d882f440517958f7a02d227dce9b61f6ad3` (base `main`). CI run ID: [40493750334](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/40493750334) CI: completed, conclusion success.

Check: Check exact-head evidence and linked paths, explicit missing/failed/skipped results, stop gates and independent reviewer/Rhys decisions. Documentation or synthetic gate tests never grant SQL/release approval; do not restart the stopped audit. Give SAFE / SAFE WITH CONDITIONS / NOT SAFE for this exact scope, listing each remaining condition.


CQ note: twelve reviewer-check paragraphs were corrected where the earlier keyword grouping overstated or missed a PR scope (for example, CI/packet/runbook PRs incorrectly received wipe-only instructions). Other packet metadata remains the original dated snapshot. New CM–CP PRs are handed over separately; no second broad inventory or audit was started.


## CX: builder 4 — one-line reviewer packets

Snapshot collected 2026-11-04T13:42:42+00:00 before the packet commit. These are the 23 open PRs from this builder’s `codex/b4-*` branches, not every PR created by the shared GitHub account. The earlier 148-PR inventory above is preserved as historical; these lines supersede older packets only for the listed builder-4 PRs. Refresh a moved head before review. A packet is not a SAFE verdict, test pass or permission to merge/run SQL.

CX itself was already open when this snapshot was collected. Its row records that pre-packet head honestly; the final publishing head is in the CX PR description and must be checked before reviewing CX. A commit cannot contain its own eventual hash. Other row heads are the actual open-PR heads returned by GitHub at collection.

| PR | Full captured head SHA | What to check |
| --- | --- | --- |
| [#290](https://github.com/rhyshume1997-alt/tolra-public/pull/290) | `d9bcbc398b283e621ea4d73bcf90ef18f7ccc1b9` | Check real contacts stay blank/private until verified; triage, staff updates and uncertain saves/sends lead to a safe stop. |
| [#291](https://github.com/rhyshume1997-alt/tolra-public/pull/291) | `01067cab327ddc7107a99a015522530d736519c8` | Check workshop/office labels and roles; only an admin corrects another person’s hours; print/training is not marked passed. |
| [#292](https://github.com/rhyshume1997-alt/tolra-public/pull/292) | `55ee54c3b64d812745731a7090c42b483571f7c0` | Check saved, queued and missing paper work are reconciled once; admin enters other staff hours and a separate person checks. |
| [#293](https://github.com/rhyshume1997-alt/tolra-public/pull/293) | `0cfe4495a805d0c41acbdbe7a5f8b892006df68a` | Check stop decisions, reserved-request refusal, kept history and backup-only recovery after 146 rollback; app/DNS rollback alone restores no data. |
| [#294](https://github.com/rhyshume1997-alt/tolra-public/pull/294) | `ac49a303512288e76c95f74522ec3abdaf251f34` | Check expected DNS/Vercel/Supabase/Auth/callback results; retain CR’s corrected lib/accounting/cloud-adapters.ts source path; live rows remain NOT RUN. |
| [#295](https://github.com/rhyshume1997-alt/tolra-public/pull/295) | `865058f4a3e9dfa1afdefb51d3d6b72d401cda29` | Check provider selection, actual receipt proof and ordinary-draft manual fallback; unknown delivery and chase approval cannot be bypassed. |
| [#296](https://github.com/rhyshume1997-alt/tolra-public/pull/296) | `b35e5caf003fba6c6f25082bcfae311ae35e5fd4` | Check literal wording only and preserved guards/calculations; keep CR’s cap correction: a spending cap is not an off switch. |
| [#297](https://github.com/rhyshume1997-alt/tolra-public/pull/297) | `b9406d136f224395a4e6f2d15f82093f1ba2f545` | Check reverse tenant bindings and retained role/CSRF/header proofs; 207 offline checks are not DB/browser proof; missing backend failures stay visible. |
| [#301](https://github.com/rhyshume1997-alt/tolra-public/pull/301) | `475e186b5b9d4fd526c9c95028c49eeb96aa63c5` | Check John/Rhys fill the actual decision cut-off from measured recovery time; all choices, deputy and backup-state/146 limits remain explicit. |
| [#302](https://github.com/rhyshume1997-alt/tolra-public/pull/302) | `e76f1c03ee5cd60f3048d5c5a115714e4b3c54bd` | Check process acceptance does not waive failed/unrun validation or the separate transfer check; John signs only his own decision. |
| [#303](https://github.com/rhyshume1997-alt/tolra-public/pull/303) | `ca1c504cf515d82533242bf373c38d2f069642fc` | Check all pasted enquiry/question text can leave JNR; both account choices go to Anthropic; NO/blank stays off and actual terms remain unapproved. |
| [#304](https://github.com/rhyshume1997-alt/tolra-public/pull/304) | `97422fe71066c8e4d225d0d38f2da837f88b4ed5` | Check past Monday/Tuesday are not invented results; offline tablet, Marpet, opening balances and safe separate practice targets are covered. |
| [#306](https://github.com/rhyshume1997-alt/tolra-public/pull/306) | `99a1a9f6e9e10b5ce7b92183a87c778b8e9fe953` | Check the exact JNR account, primary/second/owner/support powers, working admin cover and old sessions; preserve other shops and history. |
| [#307](https://github.com/rhyshume1997-alt/tolra-public/pull/307) | `8877aed34d009c7dc1c348d81932ffe103190805` | Check enrolment plus both company-database and live-deployment rules, direct refusals, recent codes and cover; no live setting is claimed changed. |
| [#308](https://github.com/rhyshume1997-alt/tolra-public/pull/308) | `289eeb67ff8535a647e9c01ddb5eadef71e411fe` | Check named decision/support people, phones, tested cover and response hours remain to be filled privately; no guessed contacts. |
| [#309](https://github.com/rhyshume1997-alt/tolra-public/pull/309) | `2562523258932a489b40862bf0f9a5e2657b8305` | Check accountant agrees the six-year start, longer holds and readable archive; no automatic purge or blanket retention of unrelated secrets. |
| [#310](https://github.com/rhyshume1997-alt/tolra-public/pull/310) | `597a195c99b2d7cb20d494f489632889dfeb45da` | Check continue versus restart-request choices preserve numbers/links; restarting holds affected work and authorises no database reset. |
| [#311](https://github.com/rhyshume1997-alt/tolra-public/pull/311) | `54e28c086dd20cd6553b53e3645b6a51c8d13ec2` | Check domain first, two exact callbacks, stored credential priority and copy fields; free development is not free live access. |
| [#312](https://github.com/rhyshume1997-alt/tolra-public/pull/312) | `bf5396b66e163cadaf5a212b268a3519f6f4b5cb` | Check domain first, Sage/QBO exact settings and real consent, sandbox/production separation and balance-only behaviour; no invoice export promised. |
| [#313](https://github.com/rhyshume1997-alt/tolra-public/pull/313) | `7ffeb44be92ce10fcace40ddce12a509d3d675c7` | Check paid-time meaning, exact-time calculation, final-total rounding and decimal hours; policy changes need a separate decision and no wages change here. |
| [#314](https://github.com/rhyshume1997-alt/tolra-public/pull/314) | `ce1118393cc0d65bfde426d31222903a802984ff` | Check CN/CU and BA source corrections, CR–CV/BA full review heads, CV reported-result limits and all unchanged NOT TESTED gates; original branches stay intact. |
| [#316](https://github.com/rhyshume1997-alt/tolra-public/pull/316) | `359249878c17b7e4586e39bbee4b7e3961c2a2e2` | Compare all twelve CW forms with their pinned originals; simpler words must preserve choices, blanks, stop rules and exact technical copy values. |
| [#318](https://github.com/rhyshume1997-alt/tolra-public/pull/318) | `1cfe764b31631899c5fa8ca368400162becc9dee` | Check one packet for every open builder-4 PR, full captured SHA and specific review action; preserve the historical file and use the final CX head in its PR description. |
