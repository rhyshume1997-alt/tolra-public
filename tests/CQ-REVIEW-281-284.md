# CQ: one read of PRs #281–#284

Reviewed 4 November 2026. Scope is the 11 changed files across these four drafts and the immediate application, manual-check and money sources needed to check their claims. No broad branch audit or full suite was restarted. This is the builder's correction pass, not an independent SAFE verdict.

| PR | Exact reviewed source head | Exact-head PR CI snapshot |
| --- | --- | --- |
| #281 CJ | ff29ca191879ec954e305ec0eb200501789a5bcf | 41825174221 completed, failure; web success, integration skipped, ci-gate failure |
| #282 CG/CK | b80b274b0f2b8b12444915152383564cc1b9bf52 | 41826333766 completed, success; not runtime proof |
| #283 CH | e40f9edb24a79769efd03b8f900c6c31d8a6729b | 41826384400 completed, success; not runtime proof |
| #284 CL | d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d | 41826433316 completed, failure; web success, integration skipped, ci-gate failure |

CQ is based on the reviewed #284 head and proposes the corrections together, so it retains the earlier evidence stack. Original #281–#284 branches are unchanged. Review and integrate CQ before treating those issues as corrected in a release candidate.

## Findings and corrections

### #281: the third N1 view was missing

`tests/e2e/acceptance/n1-paid-breaks.spec.ts` checked the working-hours weekly summary and weekly timesheet, but never opened Hours/day. `tests/MANUAL-CHECKS-GO-LIVE.md` G04.2 requires all three places to agree.

The spec now also checks the five planned daily values, the actual Hours/day Paid tile and its reload, and the paid/unpaid explanation for each separate company. Expected daily values are 8:00 and 7:15; weekly expectations remain 40:00 and 36:15. Selectors come from `app/(dashboard)/settings/page.tsx`, `components/time/day-sheet.tsx` and `components/stat-tile.tsx`; the day route follows the existing hours-display browser spec. Existing weekly and two-company assertions are retained. No application/UI code or database guard changed.

N5/N6 and the shared guard were read against setup progress, guide visibility, template detail/editor/default sources and fixtures. No additional source defect was identified in this pass. Their focused specs still do not replace every G08/G10 condition: platform creation, branding/details persistence, full role/support matrix, legacy-body round-trip, approved draft and cross-company template checks remain required elsewhere. Do not interpret test names as proof of unexecuted manual rows.

### #282: make the evidence directions precise

`tests/GO-NO-GO-EVIDENCE.md` used short sibling filenames in the post-release browser row and still told Code to fix image-store capacity as the next action. It now gives full N5/N6 paths and distinguishes current socket-permission failure from historical ENOSPC. Its CQ note names the CL money test paths only in this #284-based candidate, not as if they existed in the earlier #282-only head. All runtime gates stay NOT TESTED and NO GO remains.

Checked all 22 N2/N3 rows against the actual referenced sources: 30 named unit/database proof titles match. No dedicated-proof gap was converted to a pass. Required Operations Pack/private combined wipe/provider/MFA/cap-race evidence remains open.

### #283: some generated reviewer instructions used the wrong scope

The earlier keyword grouping gave wipe-only instructions to CI, packet, evidence, runbook and handover PRs. Twelve check paragraphs now describe their actual stated scope: #280, #279, #278, #277, #261, #246, #256, #236, #247, #251, #252 and #284. This corrects the owned packet document; it is not a new code review of those held branches.

The four #281–#284 packets now carry the reviewed source heads and observed CI conclusions above. The original 148-packet snapshot is retained and explicitly historical; no second all-open-PR inventory was started. New CM–CP jobs are handed over separately. Packet headings, full heads, CI fields and verdict requests remain present for all 148 entries.

### #284: arithmetic and costing boundary retained

Read `tests/ROUNDING-RULE.md`, `tests/fixtures/money-rounding-cases.ts`, `tests/unit/money-rounding-rule.test.ts` and `tests/db/money-rounding-parity.test.ts` against `lib/money.ts` and the numeric line/VAT expressions in migrations 016/030. No additional arithmetic source error was found. No costing engine, machine rate, half-even helper or golden expected answer changed. Real PostgreSQL parity remains unproved; a literal PostgreSQL arithmetic comparison does not establish every persisted-document or permission path. Prior focused unit results stay scoped to their actual earlier run; CQ did not repeat the unchanged money suite.

## Checks actually performed on the CQ source changes

- PASS: `npx eslint tests/e2e/acceptance/n1-paid-breaks.spec.ts` — exit 0, no findings.
- PASS: `npx tsc --noEmit` — exit 0 on the local reconstructed candidate with CQ edits.
- PASS, collection only: `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance --list` — exit 0, three tests in three files.
- FAIL, setup blocked: `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance` — exit 1 in global setup, TEST_SUPABASE_URL unset. No browser assertion ran and no SQL was applied. New Hours/day assertions remain NOT TESTED at runtime.
- PASS, document/source checks: 22 N2/N3 requirement rows and 30 exact proof titles; all 148 packet headings/CI fields/verdict requests; four refreshed source heads and matching CI IDs. File changes were checked against the captured source contents.

Local source/dependency limitation remains: `/workspace/work/builder3` is reconstructed candidate source with shared preinstalled dependencies, not a clean locked install or exact-head CI run. Code must run the changed browser spec on the verified fake-only backend with the reviewed release inventory at the actual final integrated SHA. Do not add a Ready label or bypass integration to make the CI gate green.

No main merge, production SQL, deployment, real-data access, broad audit or new scope. The current queue's final heads and unfinished work are in `tests/HANDOVER-BUILDER-3.md` on coordination PR #271. CQ's resulting full head is recorded externally in its draft PR description after commit.
