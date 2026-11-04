# LAG-MORE — timesheets and customers read-only review

Builder 4, 4 November 2026. Source: final candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. Line numbers below refer to that exact revision. This job lists findings only: **no page, helper, middleware, schema or query was changed**.

“Sequential” means one request waits for another. Some waits protect correctness. `select("*")` asks for every column, even when the screen needs fewer. Neither pattern alone proves the cause of live lag; no live timing or database requests were performed.

## Timesheets (`/time` and `/time/week`)

The route files `app/(dashboard)/time/page.tsx:5` and `app/(dashboard)/time/week/page.tsx:6` render `DaySheet` and `WeekReview`; the reads are in their components/helpers.

| File and line | Pattern / what waits | Assessment, without a fix |
| --- | --- | --- |
| `components/time/day-sheet.tsx:106`, `:112` | `databaseHasTime()` is awaited before the parallel time-data, people and startable-job loads. | Feature-availability guard. The main three loads already use Promise.all; do not remove the guard just to parallelise. |
| `components/time/week-review.tsx:71`, `:76` | Same feature guard, then `loadWeek` and `loadCompanyPeople` in Promise.all. | Already parallel after the guard; not three sequential independent reads. |
| `lib/time-week.ts:29`, `:31` | `time_week_status` finishes before time data and day flags start together. | Deliberate revision-first ordering, documented at the top of this file, so changed hours are not treated as an older approved revision. Preserve that guarantee in any future proposal. |
| `lib/time-data.ts:51`, `:58` | Events, labour and settings start together, but settings uses `select("*").maybeSingle()`. | A real wildcard, on a single settings row rather than a large list. Named settings columns could be assessed separately; no change here. |
| `lib/time-data.ts:64`, `:68` | After that first group, bank holidays finish before job-detail reads start. | Holidays need the loaded settings region; job IDs need the loaded labour. The job reads do not themselves need the holiday response. This is a possible extra wait to investigate, while preserving failure handling. |
| `lib/time-data.ts:67`, `:68` | Job IDs are read in sequential chunks of 200 with `await` inside the loop. | `ceil(unique job IDs / 200)` successive requests when nonempty; named columns already used. No batching/concurrency change made. |
| `components/time/time-settings-card.tsx:32`, `:36` | Feature check, then another `time_settings.select("*").maybeSingle()`. | Related settings panel, not an additional unconditional initial `/time` read. This is the second settings wildcard in the reviewed files. |

The fallback labour read in `lib/time-data.ts:54` follows an unknown-column error intentionally; it is not an unconditional second request. Approval/correction/save operations followed by reloads are writes with dependencies and were not classified as independent initial reads.

## Customers (`/customers`)

| File and line | Pattern / what waits | Assessment, without a fix |
| --- | --- | --- |
| `app/(dashboard)/customers/page.tsx:77`, `:82` | `fetchKnownCustomers()` finishes before the independent `customer_credit` RPC starts. | Candidate for a separate concurrency proposal. Preserve error/loading handling and customer-to-credit matching; no change here. |
| `lib/customers.ts:256`, `:257` | `fetchKnownCustomers` awaits saved customers, then starts document-name reads. | Saved records and document names are merged afterwards. Possible independent work, but a saved-customer failure currently prevents the later requests; preserve intentional error behaviour in any future change. |
| `lib/customers.ts:148`, `:136` | `fetchCustomers` awaits the mobile-column feature check and saved-customer read, then `withTraceableDefaults` performs its own query. | Feature/schema compatibility and enrichment sequence. Uses named columns; any future consolidation must keep the missing-column compatibility path. |
| `lib/customers.ts:240` | Document-name reads for RFQs, quotes, sales orders and invoices already use Promise.all. | Four table chains in parallel, each paged with fetchAll. Not a sequential four-table loop. |

No `select("*")` was found in the customers route or `lib/customers.ts`. Customer reads use `CUSTOMER_COLUMNS`, `CUSTOMER_COLUMNS_073`, `id, traceable_default`, or `id, customer`. The shared fetchAll change in the separate LAG-PAGES draft can affect page counts; this report makes no customer-code change.

## Handover / ownership

| Item | Owner | Branch | Target | Status |
| --- | --- | --- | --- | --- |
| LAG-MORE | Builder 4 | `codex/b4-lag-more` | New review branch `codex/b4-lag-review` | Read-only findings complete; own atomic `claims/LAG-MORE` reserved |

Validation: source/line comparison, wildcard scan across the route files, their time components and the time/customer loading helpers, and `git diff --check`. No new tests are needed for this report. LAG-PAGES carries the separately requested implementation and its lint/type/unit results. This report is not permission to extend that implementation, edit middleware, change #247, run production SQL, merge or deploy.
