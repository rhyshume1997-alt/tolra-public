# Codex 1 handover

**Latest takeover note:** Rhys reports that #247 has completed the full `npm run test:db`, with #239/#240 folded in and post-144 phases 145 then 146 packaged. That is externally reported evidence, not a database run by this account. Historical NOT RUN statements below describe the earlier account/session. New AI database proofs in the final section remain unrun. No SQL was applied anywhere during this takeover.

Recorded 3 November 2026. This records the work from this chat, including older branches. GitHub states below were read at handover time; later changes need a fresh check. Historical test counts come from the recorded PR results and are not claims that every old branch was retested today. Any merged PR was merged by another account, not this agent.

## Rules and limits

Draft PRs only. No deployment, production SQL, database migration/proposal execution, remote merge or demo seed write was performed here. No tests were weakened. Database credentials/backend were unavailable; collection or a clean skip is not a passed database/browser test. No private wipe material is copied into this file.

## PR inventory

| PR | State | Branch → base | Tests and unfinished work |
| --- | --- | --- | --- |
| [#130](https://github.com/rhyshume1997-alt/tolra-public/pull/130) | OPEN draft | `codex/work-ownership` → `main` | Ownership record reviewed; no runtime test recorded. |
| [#131](https://github.com/rhyshume1997-alt/tolra-public/pull/131) | OPEN draft | `codex/bank-csv-quotes` → `chatgpt/bank-matcher-more-tests` | 44 bank tests; typecheck and lint passed. |
| [#183](https://github.com/rhyshume1997-alt/tolra-public/pull/183) | OPEN draft | `codex/manual-checks` → `main` | Manual content and diff reviewed; no runtime test recorded. |
| [#184](https://github.com/rhyshume1997-alt/tolra-public/pull/184) | OPEN draft | `codex/costing-join` → `claude/costing-in-app` | 627 focused checks; typecheck passed. SQL runtime not run here. |
| [#185](https://github.com/rhyshume1997-alt/tolra-public/pull/185) | MERGED | `codex/money-edge-tests` → `main` | 16 focused money tests passed. |
| [#186](https://github.com/rhyshume1997-alt/tolra-public/pull/186) | OPEN draft | `codex/chase-join` → `claude/chase-steps` | Focused tests recorded; progression conflict superseded by #200 and combined #233. Do not merge unchanged. |
| [#197](https://github.com/rhyshume1997-alt/tolra-public/pull/197) | OPEN draft | `codex/neutral-login` → `main` | 5,028 unit tests, typecheck and lint passed; neutral-login Chromium check passed. Real-company browser checks not run. |
| [#198](https://github.com/rhyshume1997-alt/tolra-public/pull/198) | CLOSED | `codex/161-approval-test-fix` → `main` | Closed: wrong base. Replaced by #203. Four browser cases collected; live database run not done. |
| [#199](https://github.com/rhyshume1997-alt/tolra-public/pull/199) | OPEN draft | `codex/chase-send-recovery` → `claude/chase-steps` | 61 focused tests passed; recovery included in combined #233. |
| [#200](https://github.com/rhyshume1997-alt/tolra-public/pull/200) | OPEN draft | `codex/chase-progression-fix` → `claude/chase-steps` | 5,078 unit tests passed; progression rule retained. Prefer combined #233 over #186. |
| [#201](https://github.com/rhyshume1997-alt/tolra-public/pull/201) | MERGED | `codex/chase-draft-pages` → `chatgpt2/chase-customer-review-code-only` | 63 matching/chase unit tests passed. |
| [#202](https://github.com/rhyshume1997-alt/tolra-public/pull/202) | OPEN draft | `codex/costing-sql-test-plan` → `claude/costing-in-app` | 32 focused checks passed; ten database cases collected. SQL/database execution not run here. |
| [#203](https://github.com/rhyshume1997-alt/tolra-public/pull/203) | MERGED | `codex/161-approval-test-only` → `chatgpt2/e2e-chasing-code-only` | Four browser cases collected; lint passed. Database browser execution not run here. |
| [#204](https://github.com/rhyshume1997-alt/tolra-public/pull/204) | MERGED | `codex/161-reviewed-text` → `chatgpt2/e2e-chasing-code-only` | 34 focused tests, typecheck and lint passed. |
| [#205](https://github.com/rhyshume1997-alt/tolra-public/pull/205) | MERGED | `codex/161-jsdom-build` → `chatgpt2/e2e-chasing-code-only` | 5,014 unit tests, clean install and typecheck passed. |
| [#206](https://github.com/rhyshume1997-alt/tolra-public/pull/206) | OPEN draft | `codex/plain-english-privacy` → `chatgpt2/plain-english-pass` | Five-file removal and exact diff reviewed; no runtime change. |
| [#207](https://github.com/rhyshume1997-alt/tolra-public/pull/207) | OPEN draft | `codex/chase-combined` → `chatgpt2/e2e-chasing-code-only` | 5,129 unit tests, typecheck and lint passed; three existing warnings. Superseded by #233. |
| [#208](https://github.com/rhyshume1997-alt/tolra-public/pull/208) | OPEN draft | `codex/chase-layout-main` → `codex/chase-combined` | 5,311 unit tests, typecheck and lint passed. Included in #233. |
| [#209](https://github.com/rhyshume1997-alt/tolra-public/pull/209) | OPEN draft | `codex/costing-preflight-main` → `claude/costing-in-app` | 200 release/costing checks and migration checks passed; database execution not run. |
| [#210](https://github.com/rhyshume1997-alt/tolra-public/pull/210) | OPEN draft | `codex/sliq-preflight-main` → `claude/sliq-import` | 247 unit tests and migration checks passed; database execution not run. |
| [#211](https://github.com/rhyshume1997-alt/tolra-public/pull/211) | OPEN draft | `codex/manual-checks-main` → `codex/manual-checks` | Manual content and conflict resolution reviewed. |
| [#212](https://github.com/rhyshume1997-alt/tolra-public/pull/212) | OPEN draft | `codex/test-wording-followup` → `codex2/wording-pass-2` | 32 unit tests, five browser cases collected, lint passed; database browser execution not run. |
| [#213](https://github.com/rhyshume1997-alt/tolra-public/pull/213) | OPEN draft | `codex/plain-english-main` → `codex/plain-english-privacy` | Seven unit tests, lint and historical merge-tree audit passed; current conflicts require a fresh check. |
| [#214](https://github.com/rhyshume1997-alt/tolra-public/pull/214) | OPEN draft | `codex/sliq-fake-export` → `codex2/sliq-more-tests` | 132 unit tests, typecheck and lint passed; database import not run. |
| [#215](https://github.com/rhyshume1997-alt/tolra-public/pull/215) | OPEN draft | `codex/e13-offline-schedule` → `codex2/e13-more-tests` | 84 offline schedule tests, typecheck and lint passed; database/email execution not run. |
| [#216](https://github.com/rhyshume1997-alt/tolra-public/pull/216) | OPEN draft | `codex/chase-evidence-integration` → `codex/chase-layout-main` | 228 focused tests, typecheck and lint passed; live ingestion not run. |
| [#218](https://github.com/rhyshume1997-alt/tolra-public/pull/218) | OPEN draft | `codex/company-paid-breaks` → `main` | 39 focused tests, typecheck and lint passed; combined in #236. |
| [#219](https://github.com/rhyshume1997-alt/tolra-public/pull/219) | OPEN draft | `codex/ai-integration-switch` → `main` | 18 focused tests, typecheck and lint passed; combined in #234. |
| [#220](https://github.com/rhyshume1997-alt/tolra-public/pull/220) | OPEN draft | `codex/validation-pack` → `main` | 119 mapped unit tests and validation checker passed. Owner IQ/OQ/PQ evidence remains blank; protocols not executed. |
| [#221](https://github.com/rhyshume1997-alt/tolra-public/pull/221) | OPEN draft | `codex/accounting-connections` → `main` | Latest ordering change: 220 focused checks passed. Code reported 128/128 database tests before ordering change; latest upgrade rehearsal NOT run here. |
| [#236](https://github.com/rhyshume1997-alt/tolra-public/pull/236) | OPEN draft | `codex/n-company-setup-email-combined` → `main` | 5,138 unit tests, typecheck and full lint passed; database/browser execution not run. |
| [#237](https://github.com/rhyshume1997-alt/tolra-public/pull/237) | OPEN draft | `codex/o-accounting-combined` → `main` | Latest: 5,135 unit tests, typecheck, full lint and migration freeze checks passed; upgrade rehearsal not run here. |
| [#238](https://github.com/rhyshume1997-alt/tolra-public/pull/238) | MERGED | `codex/p-reviewer-manual-checks` → `codex2/n1-n6-browser-checks` | Manual steps, links and diff reviewed; merged externally into #227. |
| [#239](https://github.com/rhyshume1997-alt/tolra-public/pull/239) | OPEN draft | `codex/q-setup-access-tests` → `codex/n-company-setup-email-combined` | 12 focused tests, typecheck and lint passed; real database RLS not run. |
| [#240](https://github.com/rhyshume1997-alt/tolra-public/pull/240) | OPEN draft | `codex/q-accounting-company-read-tests` → `codex/o-accounting-combined` | Nine focused tests, typecheck and lint passed; real database/provider execution not run. |
| [#241](https://github.com/rhyshume1997-alt/tolra-public/pull/241) | OPEN draft | `codex/s-inbound-payment-evidence` → `codex2/j-chasing-combined-main` | 84 focused tests, typecheck and lint passed; live inbound/database execution not run. |
| [#242](https://github.com/rhyshume1997-alt/tolra-public/pull/242) | OPEN draft | `codex/t-offline-marketing-fonts` → `main` | 20 focused tests, typecheck, full lint and production build passed. Existing optional Resend render warning remains; visual browser comparison not run. |
| [#244](https://github.com/rhyshume1997-alt/tolra-public/pull/244) | OPEN draft | `codex/u-tolra-demo-seed` → `main` | SUPERSEDED by #243; no more U work. Earlier five unit tests/types/lint passed; seed plan only, writer never run. |
| [#245](https://github.com/rhyshume1997-alt/tolra-public/pull/245) | OPEN draft | `codex/v-reviewer-browser-conditions` → `codex2/n1-n6-browser-checks` | Four provider-mock unit tests, typecheck and lint passed. Ten browser cases skipped cleanly with no database; no browser runtime proof. |
| [#246](https://github.com/rhyshume1997-alt/tolra-public/pull/246) | OPEN draft | `codex/w-codex-1-handover` → `main` | W/AD: this handover. Inventory, links and diff reviewed; documentation only. Database/browser evidence remains unrun. |
| [#247](https://github.com/rhyshume1997-alt/tolra-public/pull/247) | OPEN draft | `codex/x-final-main-candidate` → `main` | X + AA/AB: latest 5,441 units / 409 files passed; typecheck, targeted lint, release-plan/migration checks and seven SQL syntax parses passed. AA production build passed. No AA merge conflicts. Post-144 phases 145/146 packaged, not applied; Code must rehearse them. |
| [#248](https://github.com/rhyshume1997-alt/tolra-public/pull/248) | OPEN draft | `codex/z-go-live-manual-checks` → `main` | Z: 35 unique numbered manual steps, expected results and NOT RUN evidence cells reviewed; diff check passed. No manual/runtime checks executed. |
| [#249](https://github.com/rhyshume1997-alt/tolra-public/pull/249) | OPEN draft | `codex/ac-wipe-kit-proposed-lines` → `main` | AC: nine missing-table rows and four preservation replacements reviewed; six SQL snippets parsed only; diff check passed. Chase-history FK retention blocker remains; no private edit or SQL execution. |

[Handover PR #246](https://github.com/rhyshume1997-alt/tolra-public/pull/246) targets main and changes only this file. State: open draft. Validation: inventory/link review and git diff --check; no runtime changes or runtime tests.

## Priority fixes and exact pushed heads

| PR | Head | Change and remaining check |
| --- | --- | --- |
| #221 | `53030fd4224c6b2451f2af386fdb9d692b0ee8fc` | Migration 144 creates new functions first; matching release and rollback updated. Code’s catalogue snapshot c33c667 retained. Latest upgrade rehearsal still required. |
| #233 | `5439341cc336d4325965934d7de100764ad71b91` | Browser setup installs the existing reviewed chase proposal only on the verified disposable backend and removes only its own unchanged fixture. Save waits for a successful real RPC; all original saved-message, persistence and exact-text checks remain. Database browser execution required. |
| #234 | `baafb39e1ff33d11d3c5023cd764c8fcfb8f182e` | Rebased onto fixed #221, without conflicts. 5,183 unit tests, typecheck and full lint passed. Real cap race and database/browser checks remain. |
| #230 | `ad1027ed7b57b73757e27c2dddd4e54fd863eb21` | Rebased onto fixed #221, without conflicts. Eleven focused tests, typecheck and lint passed. Real provider/database checks remain. |
| #237 | `86eda4bd48b1237b42140dbd72ace7cb73442f4b` | Exact Code catalogue snapshot and #221 ordering fix included. 5,135 unit tests, typecheck, lint and migration checks passed. Upgrade rehearsal remains. |

The rebase kept existing PR targets: #234 targets main; #230 targets the #221 branch. This was the safest reading of “rebase onto fixed #221”; no PR was merged. Raw Actions logs/artifact downloads were blocked by the network policy, so annotations and repository source were used.

## Combined branches and conflicts

- #236 combines #218, #235, #222 and #223 from main. Only conflicted file: `app/(dashboard)/settings/page.tsx`. Kept both setup-company/setup-breaks wrappers and the company details time-settings prop, organization key and settings callback. No intended behavior changed. #239 targets #236 and adds the setup access guard/tests.
- #237 combines #221 and #230 from main, without AI changes or merge conflicts. #240 targets it with company-isolation route tests.
- #241 targets #233. The inbound test exercises the existing inbox ingestion path; it does not claim a separate paid-reply classifier exists. Normal inbox/RFQ bookkeeping remains; financial fields and payments never change.
- #245 targets #227. Its ten new browser cases need the assembled application described in `tests/e2e/reviewer/README.md`: #236/#239, #233/#241, #237/#240 and #234, with the reviewed schema prepared separately. No proposal is installed by this browser pack. Strict existing CI configuration remains unchanged.

## Review-only work and source branches

- L: #235 was reviewed without edits. Four targeted tests and the full 5,114-unit suite passed, along with typecheck and full lint.
- R: #221 changed the integration enqueue function body used by frozen migration 084 replay guards. The offline hash failure was reproduced and fixed by preserving the original function and introducing a separate accounting function. A replay stopping before later migrations can explain the reported time-labour/end_reason and cron failures; those two database runtime failures were not reproduced here. See `tests/accounting/DB-FAILURE-REVIEW.md`.
- Q: #233 approval suites passed 48 tests; #234 AI/key/cap/control suites passed 43 tests. The real two-connection cap race already exists but was not run here.
- Wording fixes were committed directly to the existing #188 and #194 branches; these were not new PRs. Assertions were kept.
- The private JNR wipe kit was reviewed read only earlier. Nothing was executed. A real backup/restore rehearsal and operator confirmations remain operational sign-off, not a public-code claim.

## X, Y, Z and AA–AC update

- X/#247 starts from main `68f89ca` and combines #233 → #236 → #237 → #234 → #242 in order. Original X conflicts were only `supabase/verify/release_preflight.sql` (kept both 138/144 markers) and `.github/workflows/ci.yml` (kept baseline rehearsal and both guarded proposal proof stages). X's first full result was 5,428 units and a successful build. Expanded lint found pre-existing CommonJS no-require errors and generated Next types; no rule was weakened to hide them.
- AA folds #239 (real setup access fix plus role/support tests) and #240 (accounting read isolation tests) into #247. **No conflicts.** AA alone passed 5,437 units, typecheck and production build. Latest application behavior now includes the explicit non-support, own-company admin setup guard. #241/#245 remain separate; no unrequested follow-up was silently included.
- AB reserves **145 N5 setup → 146 N2/AI cap**, after baseline 144, in `supabase/release-plan.json`. These are explicit one-time post-numbered release phases with transactional guards, exact canonical proposal bodies, rollback/verify copies and preflight markers. Safest-reading assumption: keep them outside the frozen baseline `supabase/migrations/` replay because N2 renames functions required by the unchanged 103/133/134 guards. A future numbered migration reusing 145/146 makes the checker fail; reconcile the plan first. No application/startup auto-install exists.
- AB's coverage check is integrated into `npm run check:migrations`. Four mutation tests catch new/existing proposals missing from preflight/plan, a deleted marker, numbering/order errors and stale package copies. All proposal SQL files have a preflight disposition, including deferred costing and rollback-only SQL. CI still runs the numbered catalogue/upgrade rehearsal first, then both release phases and all three original setup/AI/race proof files. Legacy preflight AI checks inspect the preserved own-key bodies after 146; a separate marker pins all ten live function bodies and sensitive metadata/grants.
- Final AA/AB head: `382363a` on #247. **5,441 units / 409 files passed**, typecheck, targeted lint, release-plan/migration checks and seven pure SQL syntax parses passed. AA's production build passed. No database, proposal or release SQL was executed here. Code must still prove phase application, atomic repeat refusal/no-change, reverse rollback, real role isolation/cap race and browser checks. Syntax parsing is not SQL runtime proof. Details: `tests/POST-144-RELEASE.md` and `tests/GO-LIVE-CANDIDATE.md` on #247.
- Y read the private kit only. AC/#249 publishes proposed lines in `tests/WIPE-KIT-PROPOSED-LINES.md`, with no private IDs/secrets or private edits. Nine missing tables are classified; settings/caps/history stay KEEP and only JNR operational chase pauses are proposed WIPE. Existing AI request/usage and send/email-history rows have preservation replacements. The Xero-only disconnect predicate expands to Sage/QuickBooks. No SQL was run.
- **Wipe blocker:** kept chase approval rows have a non-null cascading invoice FK and set-null history FKs. There is no delete order that removes parents while keeping those approvals intact. AC proposes an early refusal and leaves the existing KEEP→WIPE guard intact. A reviewer must settle a separately proven parent-retention/archive design before any wipe; never delete approvals, disable FKs or reset numbering to get past the guard. Preserve logins, settings, earlier audit rows and every Marpet/other-company row.
- Z/#248 adds `tests/MANUAL-CHECKS-GO-LIVE.md`: 35 numbered steps for the ZZ invoice, exact-text approval, paid claim, paid/unpaid breaks, AI, Xero, accountant invites and new blank company. Every expected-result/evidence row is NOT RUN. These are instructions, not go-live evidence.
- AD updates this existing draft #246 rather than opening another handover PR. Inventory states were refreshed from GitHub; older test results were not rerun. No GitHub merge, Ready label, SQL application or deployment occurred.

## What is next

1. Run the latest #221 and #237 upgrade rehearsals, keeping Code’s exact catalogue snapshot. Do not treat the earlier 128/128 report as proof of the later ordering change.
2. Run #233’s browser suite against the verified disposable backend with the reviewed proposal fixture. Confirm saved message, exact approved text, edit invalidation, double-send and uncertain-delivery behavior.
3. Prepare a separately reviewed test database and assembled feature application, then run #245’s ten browser cases, existing #227 cases and the real two-connection AI cap race. Check provider encryption, company isolation, admin/support access and paid/unpaid timesheet agreement.
4. Review #242 visually. Its production build succeeds without downloading Google Fonts.
5. U/#244 is superseded by Claude Code's #243. Its PR description says so; it remains open and draft. Do no more U work and do not use its seed for the new blank-company check. #243's disposable-CI proof was reported by the user, not rerun here.
6. Review overlaps before merging: #198 is closed in favor of #203; older chase joins are superseded by #233. Select the costing line deliberately rather than merging overlapping #184/#190 implementations. No automatic closing or merging was done.
7. Fill in validation protocol evidence from actual execution. Unit passes, collected cases and skipped browsers are not operator validation evidence.

## Tick list

- [x] S ; #241 ; draft; run database/inbound checks next.
- [x] T ; #242 ; draft; visual review next.
- [x] U ; #244 ; superseded by #243; stopped, left open/draft.
- [x] V ; #245 ; draft, ten browser cases skipped without DB; configured runtime next.
- [x] W ; #246 ; draft; reviewer can update the Master Plan from this inventory.

- [x] X / AA ; #247 ; draft; own-admin setup fix and accounting read tests included, no AA conflicts; Code runtime rehearsal next.
- [x] AB ; #247 ; release packaging/preflight coverage built and tested, not applied; Code reviews the explicit post-144 phase assumption and rehearses next.
- [x] AC ; #249 ; draft proposal only; reviewer retention decision and disposable proof next.
- [x] AD ; #246 ; handover updated; Master Plan update next.
- [x] Z ; #248 ; draft click checklist; Rhys's evidence run next.


## AH, AI and AJ takeover, 3 November 2026

Rules retained: own branches, draft PRs only, no SQL execution anywhere, no deploy, no merges, no private repo access, no exposed secrets, no weakened assertions. Work was performed in AH, AI, AJ order. Git push and GitHub API authentication expired during AI (git authentication failure, then HTTP 401). No interactive login or secret inspection was attempted. AH was already published as draft #250. Authentication recovered during AK. All six AI branches are now pushed as drafts #251 to #256. AJ is being published from this committed handover; database execution remains NOT RUN.

### AH: review-only wipe follow-up

Draft [#250](https://github.com/rhyshume1997-alt/tolra-public/pull/250), `codex2/ah-wipe-retention` into `codex/ac-wipe-kit-proposed-lines` (#249). The stated #249 head already contained the reviewer's first AH decisions, protected archive and table parser. The follow-up retained those instead of redoing them. It fixes a real design flaw: `public.canonical_jsonb` rejects numeric JSON, but invoice snapshots contain numbers. Proposed digests now use stored JSONB text and still independently compare the full evidence. New mutations reject added duplicate table rows and unscoped archive predicates, while preserving the reviewed baseline list. Five focused unit tests passed; types/lint passed. No archive or SQL was executed.

KEEP: chase_steps, costing_materials, costing_machines, costing_defaults, company_setup_progress, ai_helper_tolra_companies and global ai_helper_tolra_control. JNR-only WIPE: chase_sends and chase_pauses. Archive exact send/draft/invoice evidence first, verify equality/digests, capture protected fingerprints, then delete sends, pauses and invoice parents. The archive has no FK into deleted parents and is owner-only/immutable. Xero, Sage and QuickBooks must all be disconnected for JNR only. Marpet, logins, settings, numbering and prior audit entries remain protected. Private material was not read or edited in this takeover. A real restored-copy archive/rollback/FK proof is still required by an authorised operator.

### AI: independently targeted database proofs

| Target | Local branch | Added real proof | Focused unit checks | Next |
| --- | --- | --- | ---: | --- |
| #236 `codex/n-company-setup-email-combined` | `codex2/ai-setup-db-236` | `tests/db/setup-reviewer-permissions.test.ts`: two-company admin/staff/support SQL matrix | 4 passed | [#251](https://github.com/rhyshume1997-alt/tolra-public/pull/251): approved DB run |
| #239 `codex/q-setup-access-tests` | `codex2/ai-reviewer-db-239` | `tests/db/reviewer-setup-conditions.test.ts`: same SQL matrix on access-fix head | 12 passed | [#252](https://github.com/rhyshume1997-alt/tolra-public/pull/252): approved DB run |
| #241 `codex/s-inbound-payment-evidence` | `codex2/ai-reviewer-db-241` | `tests/db/reviewer-inbound-conditions.test.ts`: real delegated paid/remittance RPC, duplicate messages, full invoice/payment snapshots for two companies | 4 passed | [#253](https://github.com/rhyshume1997-alt/tolra-public/pull/253): approved DB run |
| #232 `codex2/i-owner-ai-caps` | `codex2/ai-reviewer-db-232` | `tests/db/reviewer-cap-conditions.test.ts`: real cap setter isolation and authenticated write/read refusal | 42 passed | [#254](https://github.com/rhyshume1997-alt/tolra-public/pull/254): run proof and existing race |
| #233 `codex2/j-chasing-combined-main` | `codex2/ai-reviewer-db-233` | `tests/db/reviewer-chase-conditions.test.ts`: real PostgreSQL claims, exact text captured by mock mail transport, simultaneous approvals send once, uncertain result never resends | 39 passed | [#255](https://github.com/rhyshume1997-alt/tolra-public/pull/255): approved DB/provider-mock run |
| #234 `codex2/k-ai-combined-main` | `codex2/ai-reviewer-db-234` | `reviewer-cap-conditions.test.ts` plus `reviewer-accounting-permissions.test.ts`: two-company Sage/QBO metadata, private secrets, OAuth role/support permissions | 66 passed | [#256](https://github.com/rhyshume1997-alt/tolra-public/pull/256): run proofs and existing race |

Every branch passed TypeScript and targeted changed-test lint. The counts above are existing focused UNIT regressions, not passed SQL tests. New database files have no skip or schema installer. Setup/support and inbound/cap SQL fixtures roll back. The chase test uses the real test database with a mock mail transport and synthetic world cleanup; it does not call a live provider. No production code was changed for AI because no database test was executed to expose a new application bug.

The real two-independent-connection cap race already exists in #232/#234 at `tests/db/tolra-ai-cap-concurrency.test.ts`; it was retained, not duplicated or replaced with a fake concurrency model. Code still must execute it. Inbound assertions exercise `mailbox_record_inbound`, not merely the older admin intake path. SQL permission tests use real authenticated PostgreSQL role/claims and two synthetic companies. The support test distinguishes harmless zero-row RLS updates from statement-level support refusals. Accounting metadata may be read by an own-company support admin under existing SQL policy, but OAuth writes and private token reads must be refused; the HTTP routes remain stricter.

Do not immediately run new setup/cap files as numbered-baseline tests when integrating them into #247. First register them with the existing serial post-144 sequencer/identity-guarded release fixture: setup after 145, cap after 146. This is a required integration step, not permission to exclude or skip tests. Preserve `npm run test:db` as the full command. Do not rewrite frozen catalogue expectations to accommodate post-146 function renames. The standalone follow-up branches require their separately reviewed schema to be prepared before these tests; they never apply it themselves. All actual DB, release, rollback, provider and browser execution is NOT RUN here under the no-SQL rule.

### Published reviewer proofs: operator handoff

All six AI branches are pushed and have draft PRs linked above, each into its exact source branch. No local branch was merged into another. Run `npx vitest run -c vitest.db.config.ts <the row's file>` only on the separately authorised disposable backend with required schema. SQL tests must actually run and pass; missing credentials/schema are failures, not skips. Run the existing cap race on #232/#234 as well. Do not use a private repo or hosted company database.

AJ is `codex2/aj-takeover-handover`, based on #246 `codex/w-codex-1-handover`, for a draft back into that branch. It includes the reviewer matrix reconciliation. No implementation or test needs recreating. AK is queued next against #247 for the N4 validation pack and dated evidence runner.

### Item state tick list

- [x] N1: #218/#235, included in #236/#247; paid/unpaid unit coverage exists; actual operator/browser evidence remains separate.
- [x] N2: #219/#224/#232/#234/#247; both key modes and owner caps implemented; new AI SQL proofs and cap race need execution.
- [x] N3: #221/#230/#237/#240/#247; accounting code and unit coverage exist; new expanded SQL provider permissions need execution.
- [x] N4: #220 validation pack; actual IQ/OQ/PQ report evidence must still be filled from real runs.
- [x] N5: #222/#236/#239/#247; own-admin access fix included in candidate; new SQL role/support matrices unrun.
- [x] N6: #223/#236/#247; editor and legacy-text unit coverage exist; browser evidence remains separate.
- [ ] N7: no matching product-item brief is identified in the supplied handover/matrix. An unrelated old worksheet test also uses the label N7; do not infer a new product requirement from it.

### Every job state tick list

- [x] A: N5 #222; SQL/database checks separate.
- [x] B: N6 #223; browser checks separate.
- [x] C: provided AI #224; cap change #232.
- [x] D: chase main refresh #226.
- [x] E: #201 description correction posted.
- [x] F/G: #227 browser/manual/database handoff; earlier instructions are historical where #247's newer phase sequencing supersedes them.
- [x] H: #228 own/provided keys; #229 AI company isolation; #230 Sage/QuickBooks token/provider isolation.
- [x] I: #232 owner caps and existing real race proof, included #234.
- [x] J/K: combined #233/#234; use the newer #247 candidate for final combined release review.
- [x] L: #235, reviewed by prior account; no duplicate implementation needed.
- [x] M: truthful banner in #226/#233; approval/security logic unchanged.
- [x] N/O: #236/#237; final candidate #247 includes their requested follow-ups #239/#240.
- [x] P: #238 merged externally into #227; manual execution evidence still pending.
- [x] Q: #239/#240; database gaps now represented by published AI proofs, not claimed passed.
- [x] R: #221 ordering fix reported by earlier account; do not repeat old source blame without exact failed-run evidence.
- [x] S: #241 inbound evidence; new real SQL financial-invariance proof in AI, unrun.
- [x] T: #242 offline fonts; visual review separate.
- [x] U: #244 superseded by #243 seed identity guard; no more U work or seed write.
- [x] V: #245 reviewer browser specs wired to CI; runtime evidence separate.
- [x] W/AD: #246 original handover; AJ is this follow-up for publication.
- [x] X/AA/AB/AE: #247 candidate, #239/#240 folded, full DB command and phases 145 then 146 packaged. Rhys reports a full DB run by Code; not rerun here.
- [x] Y: private kit read-only review by earlier account; no private access by this takeover.
- [x] Z: #248 go-live manual checklist; actual sign-off separate.
- [x] AC: #249 first wipe proposal; AH follow-up #250 corrects numeric-safe archival hashing and parser scope.
- [ ] AF/AG: no job definitions or outcomes recorded in the supplied handover; do not invent completion.
- [x] AH: #250 draft, five unit tests passed; private repo untouched, no SQL applied; restored-copy proof still required.
- [x] AI: drafts #251 to #256 pushed; types/lint/focused units passed; every database proof remains unrun.
- [x] AJ: handover and matrix updated for a draft into #246; no application change; next is operator evidence and AK.
