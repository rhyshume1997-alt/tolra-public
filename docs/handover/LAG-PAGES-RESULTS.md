# LAG-PAGES — targeted loading changes and handover

Builder 4, 4 November 2026. Based on the exact final candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. Implementation branch: `codex/b4-lag-pages`. PR target: **new** branch `codex/b4-lag-review`, pinned to that candidate. No changes were pushed to `claude/247-final`, #247, main or middleware. Own atomic `claims/LAG-PAGES` reserved; Code retains middleware ownership.

## Changes and preserved results

- `lib/fetch-all.ts`: stop after a later nonempty response is shorter than the previously observed response size. Keep the first short response's confirming read, so a server cap below the requested 1,000 cannot silently hide rows. Rhys explicitly chose to retain smaller-cap support. Stable ordering, duplicate removal, error propagation and the 20,000-row truncation signal remain.
- `app/(dashboard)/dashboard/page.tsx`: the independent tile, analytics and owner-only money groups start in one Promise.all. Query arguments and calculations are preserved. Office still makes no owner-only money requests. The dependent job-plan lookup still waits for its input; no permission/fallback/figure logic was removed.
- `app/(dashboard)/jobs/page.tsx`: replace the list wildcard with 24 real named columns needed by the unchanged row mapper. The board's offline readers use the same mapped fields and ID/start/finish patches. Change only the recurring timer from 60 to 300 seconds. Keep the existing hidden-tab guard, focus/visibility refresh, sync refresh and busy/coalescing logic.

Only those three production files changed. No migrations, middleware, role changes, UI changes, new cache, unrelated fetch refactor or live operations.

## Requests before and after

These are **code/mock counts, not measured live traffic or a speed benchmark**. Rows/caps below assume stable data, below the truncation bound. Actual totals depend on data, feature fallbacks, roles and focus/sync events.

| Read / condition | Candidate before | This change | Evidence / limit |
| --- | --- | --- | --- |
| Shared fetchAll: empty list | 1 | 1 | Empty response ends immediately. |
| Shared fetchAll: first page has 500 rows, cap 1,000 | 2 | 2 | First short response could instead mean a smaller server cap; confirming read deliberately retained. |
| Shared fetchAll: exactly 1,000 rows, cap 1,000 | 2 | 2 | Exact multiple still needs the empty response. |
| Shared fetchAll: 1,500 rows, cap 1,000 | 3 | 2 | Later 500-row response ends the loop; no empty request. |
| Shared fetchAll: 2,345 rows, cap 400 | 7 | 6 | Keeps all 2,345 rows; later 345-row response ends the loop. |
| Admin dashboard, one-row fixture with tile RPCs available and one job-plan batch | 34 | 34 | Same request set; top-level independent groups change from 3 sequential groups to 1 concurrent group. Dependent plans/paging remain. |
| Office dashboard, same fixture | 19 | 19 | Two sequential groups become concurrent; owner-only money queries remain absent. |
| Jobs initial list, fewer than 1,000 rows | 2 list requests | 2 list requests | Narrower payload, not fewer requests for this case. Other board helpers/hooks are additional unchanged reads. |
| Jobs initial list, 1,500 rows at cap 1,000 | 3 list requests | 2 list requests | Shared fetchAll saving; named projection does not itself remove requests. |
| Jobs timer, each five-minute visible period, excluding initial/focus/sync reads | 5 refreshes / 15 core RPCs | 1 refresh / 3 core RPCs | **80% fewer timer refreshes.** Three core RPCs are machines_in_use, bench_runs_state, paused_machines. |
| Jobs timer while hidden | 0 reads | 0 reads | Existing guard retained and tested. |

A jobs refresh also reads run facts: total per refresh is `3 + F + R`, where F is the paged machine_runs read count and R is the number of 200-job admin-release reason batches. For nonempty run facts fitting the first response, F remains 2 under the cap-preserving rule. People/assignable reads are not repeated by the timer. Focus, visibility and sync events still refresh immediately and may add reads independently of the timer.

The original claim “every list costs two requests, so stop on any short response” conflicts with keeping smaller-cap support. This patch deliberately does **not** promise 2→1 for an initial short page. Removing that confirmation needs a separate reliable total/cap contract; no expensive count query was added here.

## Validation record

Four result snapshots were generated from the **untouched pinned candidate**, before editing production code: admin, office, invoice-read failure, and full/default/legacy-date job mapping. The changed code matched them without regenerating snapshots. Tests execute the actual local page functions/effect via TypeScript AST extraction rather than copying an alternative implementation or adding invalid Next page exports.

- Focused regression check: **24 passed / 2 files**, including smaller caps, exact multiples, errors, duplicate handling, truncation, concurrent start, office exclusion, named projection parity, visible/hidden polling, focus and cleanup.
- First full run using reused dependencies/default execution permissions: **5,483 passed, 8 failed / 415 files**, 206.24 seconds. Six failing files involved missing candidate font packages or child-process execution permissions. Not reported as a pass.
- Installed the candidate's exact lockfile in this worktree with `npm ci --ignore-scripts`, using a workspace-local cache; did not modify shared dependencies or package manifests. Child-process version probe succeeded under the permitted execution profile.
- Failure recheck plus focused tests: **150 passed / 8 files**, 5.36 seconds; all earlier failing tests passed. No test was weakened/skipped or subprocess assertion removed.
- Final full-unit run with corrected dependencies/permissions (`npm test`): **5,491 passed / 415 files; 0 failed, skipped or todo; 196.55 seconds; exit 0.**
- Typecheck: `npm run typecheck` passed; direct locked-dependency `node node_modules/typescript/bin/tsc --noEmit` also passed, exit 0.
- Lint: full locked-dependency check passed, exit 0: `node node_modules/eslint/bin/eslint.js . --no-eslintrc --config .eslintrc.json --ext .js,.jsx,.ts,.tsx` — **0 errors, 14 warnings, all in unchanged files**. The explicit config uses the unchanged project rules and avoids loading a second Next plugin from the parent checkout; no rule/config was weakened. This checks TypeScript as well as JavaScript.
- `git diff --check` passed. Dashboard rendering/workshop loader and the jobs row mapper are byte-for-byte unchanged. An AST comparison found identical arguments across all 62 dashboard query/filter calls before and after. Final publication must compare the committed tree with the draft's remote tree.

The installed Next package lacks `node_modules/next/dist/docs/`. Its README and the official **v15.5.28** fetching-data guide were read instead, including the parallel Promise.all guidance. No Next routing/middleware/server-fetch API changed.

## Remaining operational proof / next owner

No browser, database, live request trace or live timing test was performed. Rhys/reviewer should compare dashboard figures and job actions on the approved assembled candidate, including offline reconnect and a five-minute visible/hidden cycle. Stop on changed figures, missing jobs, duplicate work or unexpected permissions; do not deploy merely because these unit checks pass. Less frequent background polling means other users' changes can wait up to five minutes while this tab stays visible; explicit focus/sync refreshes remain.

LAG-MORE is separate draft **#343**, with read-only timesheet/customer findings and pinned file/line references. It makes no further fixes. Neither job changes #247, merges to main, adds Ready, runs production SQL or deploys.

Final implementation and this completed handover are committed. LAG-PAGES is ready for review as a draft, not for merge/deployment. LAG-MORE remains separate #343.
