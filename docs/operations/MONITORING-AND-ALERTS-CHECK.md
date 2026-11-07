# Monitoring and alerts check for the Thu 12 Nov go-live

**DRAFT - findings only, not approved.**

- Base: `e70f6633b0f02f0e1dd38391ade87330d38a6a1c`. Branch: `claude/ops-monitoring-check`. Local commit only, not pushed.
- Method: read the repository only. No Vercel, Supabase, Gmail or other hosted tool was called, no production URL was requested, no secret or real data was read.
- Paths are relative to the repo root. `file:line` refers to this base commit.
- Anything that depends on the live system (environment variables, which migrations are applied, Vercel plan features, inbox contents) is marked **NOT VERIFIED**.
- This is a description of what the code does. Code changes appear only as "Option for Rhys" and are not done.

## 0. Summary in plain words

What exists:
- One e-mail alert path to the owner (Resend, `ALERT_EMAIL_TO`) for unhandled server errors, cron job crashes and browser error screens. It is redacted and rate limited. `instrumentation.ts:9-12`, `lib/server/error-alert.ts:100-143`.
- A public `/api/health` endpoint that checks the auth service and the database. `app/api/health/route.ts:36-43`.
- Two Vercel crons (daily and nightly). `vercel.json:3-6`.
- Per-company admin screens: Xero send log, Xero held list, audit log, Activity page, sync chip. Details in section 3.

What does not exist in the repo:
- No Slack, webhook, SMS, pager, Sentry or any third-party monitoring (`package.json` has none; no `slack`/`pagerduty`/`webhook` string in `app` or `lib` outside unrelated code). The only outbound alert is one e-mail.
- No scheduled uptime pinger. `app/api/health/route.ts:5` says it is "Answered by ... `.github/workflows/uptime-check.yml` ... (docs/MONITORING.md)". At this commit `.github/workflows/` holds only `ci.yml` and there is no `docs/MONITORING.md`. The same is true of `nightly-backup.yml` (named at `scripts/backup-run.sh:2`, `:23`) and the capacity workflow (`scripts/capacity-check.mjs:3`). Whether they exist on another branch or in the private repo is **NOT VERIFIED**.
- No screen that reads `security_audit.integration_invite_refusals`. SQL only.
- No alert when a pass finishes with counted failures (only when it throws). See gap G2.

## 1. Scheduled jobs

### 1.1 What runs, how often

| Job | Trigger | Evidence | Runs |
|---|---|---|---|
| `/api/cron/daily` | Vercel cron `0 5 * * *` UTC | `vercel.json:4` | (1) e-mail schedules pass, 30 s budget; (2) Xero sweep |
| `/api/cron/nightly` | Vercel cron `0 22 * * *` UTC | `vercel.json:5` | overview snapshot, clock-in IP purge, AI helper 12-month purge |
| `/api/cron/email-schedules`, `/api/cron/xero-sweep` | none (thin copies for the Pro plan) | `app/api/cron/daily/route.ts:26-31` | not scheduled |
| `/api/cron/overview-snapshot`, `ip-purge`, `ai-helper-purge` | none directly (called by nightly) | `app/api/cron/nightly/route.ts:5-7, 32-34` | via nightly |
| `/api/cron/mail-poll` | **none** | `app/api/cron/mail-poll/route.ts:19-20` "NOT in vercel.json" | not scheduled |

Notes:
- Only two crons exist because production is on Vercel Hobby (`daily/route.ts:17`, `nightly/route.ts:13`). Hobby runs each at most once a day and may start it anywhere in the hour (`lib/email/schedules/due.ts:8-11`). The code states the Hobby limits; the live Vercel plan is **NOT VERIFIED**.
- E-mail schedules are therefore sent once a day, up to about 21 hours after the chosen time (`due.ts:9-11`, `lib/email/schedules/form.ts:11` `EXACT_TIME_SENDING = false`).
- Microsoft 365 inbox reading has no server schedule. It runs only while an admin or office user has a visible Tolra tab open: a browser timer calls `POST /api/mail/check` about every 3 minutes (`lib/inbox-auto-check.ts:3-8`, `CHECK_EVERY_MS` at `:14`). Nobody with Tolra closed means no inbox reading.
- Xero queued documents: the automatic send is a browser nudge right after issue (`lib/integrations/nudge.ts:9-21`, server side `app/api/integrations/xero/after-issue/route.ts:33-35`). If the tab closes or the call fails, the document waits for an admin "Send now" or the daily sweep. The engine's retry delays are 1, 2, 4, 8, 16, 60 minutes (`lib/integrations/engine.ts:22-25`), but with one sweep a day a retry effectively happens once a day, and `MAX_ATTEMPTS = 6` (`engine.ts:19`, `:160`) can take about six days to give up. That is an inference from the schedule, not tested.
- Database-side jobs: no `pg_cron` or `cron.schedule` anywhere in `supabase/migrations`, `supabase/release` or `supabase/setup`. Release SQL is run by hand (`scripts/release-sql.mjs`). The 180-day retention purge of the invite refusal log is explicitly "not part of this proposal" (`supabase/release/151_xero_invite_hardening.release.sql:69-70`).
- Backups: `scripts/backup-run.sh` says it is run by `.github/workflows/nightly-backup.yml`, which is not in this tree (see section 0). Whether nightly backups run is **NOT VERIFIED** from this repo.

### 1.2 How a failure is noticed

| Situation | What happens | Evidence |
|---|---|---|
| A job throws | `console.error` plus one alert e-mail (if `ALERT_EMAIL_TO` is set in Production); route answers 500 after all jobs ran | `daily/route.ts:42-54`; `nightly/route.ts:40-47`; `ip-purge/route.ts:95-99`; `overview-snapshot/route.ts:142-146` |
| Nightly sub-job crashes inside its handler | Each handler alerts for itself; nightly only counts the 500 | `nightly/route.ts:35` |
| Pass runs but counts failures (`failed`, `errors`, `needsReconnect`, `needsCheck`) | Logged as a line with counts, answered **200**, **no alert** | `lib/email/schedules/pass.ts:15`; `lib/integrations/xero-pass.ts:25`; `daily/route.ts:37` (500 only when a job threw) |
| Migration not applied (108, 084, 149, 116, 127, 133) | Answered 200 with a `skipped` reason, **no alert** (by design, "no false alarm") | `xero-pass.ts:20-22`; `overview-snapshot/route.ts:130-133`; `mail-poll/route.ts:20` |
| Cron never fires or Vercel kills the function at `maxDuration = 60` | Nothing in the code can notice. The platform timeout is not caught by the try/catch | `daily/route.ts:10`; `sweep.ts:21-37` has no overall time budget across companies |
| `CRON_SECRET` missing or under 16 characters | Every call is refused with 401, so the jobs silently never run | `lib/server/cron-auth.ts:5, 15-16` |

Whether Vercel e-mails the owner about failed cron invocations is **NOT VERIFIED**. The cron dashboard is the only place to see invocation history (**NOT VERIFIED**).

### 1.3 Authentication of cron routes

- Guard: `isCronRequest` in `lib/server/cron-auth.ts:14-20`. Needs `Authorization: Bearer <CRON_SECRET>`; secret under 16 characters or unset refuses everything; both sides are SHA-256 hashed then `timingSafeEqual`, so constant time; the secret is never logged or returned.
- Every one of the 8 cron routes calls it first and returns 401 before reading anything (`daily:34`, `nightly:31`, `email-schedules:30`, `xero-sweep:170`, `mail-poll:24`, `ip-purge:61`, `overview-snapshot:125`, and `ai-helper-purge`, see its header). The `ai-helper-purge` guard line was not re-read for this document; **NOT VERIFIED** line-level (the file imports `isCronRequest` and `reportServerError`).
- The routes are also reachable by GET from the open internet; the secret is the only protection. Is `CRON_SECRET` set in Production: **NOT VERIFIED**.

### 1.4 Idempotency and overlap

- E-mail schedules: each occurrence has a period key; the database holds one run per schedule per key; `claim` returns claimed/done/busy (`lib/email/schedules/due.ts:12-15`, `run.ts:28`). A claim left "running" is retried after 10 minutes by the next tick (`run.ts:43-44`), which with one tick a day means the next day (inferred). Catch-up window is 48 hours (`due.ts:22`), so one missed day is recovered and two are not.
- Xero sweep: the database claims one row at a time with `FOR UPDATE SKIP LOCKED` and a 120 s lease (`engine.ts:6-7, 20`); every provider write carries the row id as Idempotency-Key (`engine.ts:8`; `processCreate` passes `tolra-${send.id}` at `:219`). Two overlapping runs cannot send the same document twice per the comments; not tested here.
- IP purge, snapshot, AI purge: safe to run twice (`ip-purge/route.ts:57-58`, `overview-snapshot/route.ts:122`).
- Daily route: the two jobs run in turn, each in its own try/catch (`daily/route.ts:35-36`). A slow e-mail pass is capped at 30 s so the sweep still fits (`:14`).

## 2. Provider failure handling

| Provider | Timeout | 401 | 429 | 5xx / network | Retry or backoff | Logged | Shown to the user | Evidence |
|---|---|---|---|---|---|---|---|---|
| **Xero** | 20 s per call | token refreshed once, then row stays `pending`, company marked `needs_reconnect` and paused | run stops until `Retry-After` (default 60 s), row `pending` | outcome "unknown": reads Xero back by Tolra number; found = sent; not found = retry later; cannot tell = `needs_check` | 1,2,4,8,16,60 min, max 6 attempts then `failed`; effectively daily (see 1.1) | `console.error` with code only; engine writes `last_error` on the row | Send log rows and badges, "Check in Xero", "Needs connecting again" | `lib/integrations/xero/client.ts:15, 80-89, 171-180`; `engine.ts:122-139, 165-173, 226-232`; `lib/integrations/send-log.ts:41-64`; `lib/integrations/overview.ts:34-52` |
| **Microsoft 365 mail (send)** | 15 s | fails; token source marks connection `needs_reconnect` on refused refresh | fails with `rateLimited`; user told "busy, wait a minute" | "unknown", never retried automatically | none, and no automatic switch to Resend | `console.error("[company-email] send", ...)` | Plain error text on the send; history row `failed` or `unknown`; admin settles in Email history | `lib/email/providers/microsoft.ts:34-53`; `lib/email/send-company-email.ts:238-246, 253`; `lib/send-outcome.ts:12, 28-42`; `lib/integrations/tokens.ts:62-81` |
| **Microsoft 365 mail (read)** | 15 s | token renewed once, else `signin` | `busy` | stored as an error code on the mailbox state | next browser tick (about 3 min while a tab is open) | `[mail/delegated]` lines | Inbox card status (`needs_reconnect`, `failed`) | `lib/integrations/microsoft/inbox.ts:63-72, 108-124, 145-160`; `lib/inbox-auto-check.ts:23` |
| **Resend** | 15 s | 4xx = definite refusal, may be retried by a person | `rateLimited` flag; same message | "unknown", not retried | none (Resend's own idempotency key stops duplicates) | `[company-email] send` | As above | `lib/email/providers/resend.ts:20-37`; `lib/send-outcome.ts:19-25` |
| **Resend (owner alert mail)** | 8 s | fails quietly | fails quietly | fails quietly | none | `[error-alert] send failed` only | Nothing. A lost alert is only visible in Vercel logs | `lib/server/error-alert.ts:52, 127-134, 139-142` |
| **Anthropic AI** | per request, set by caller | refused key is shown to the admin ("AI service refused this company's key") | "unavailable" with detail `rate` | "not answering right now", nothing changed | **none by design** (SDK retries off, one reservation pays one attempt) | `[ai-helper] model call failed` plus settle writes the failure | Plain 503/502/422 messages; request row `failed` | `lib/ai-helper/anthropic.ts:11-12, 35-42`; `lib/ai-helper/server.ts:33-45, 137-142` |
| **Supabase (server)** | **no timeout set** on the service client | n/a | n/a | one retry after 150 ms on 502/503/504 for GET/HEAD/PATCH/PUT/DELETE and listed safe RPCs only; inserts and other RPCs never | single retry | `[supabase] gateway ... retrying once` | A failed read becomes an error page or "Forbidden"-style message | `lib/server/resilient-fetch.ts:13-15, 33-42`; `lib/server/supabase-admin.ts:16` |

Xero queue hold (release 149):
- Switch lives in `public.xero_transfer_hold`, off by default; missing function, missing row, read error or odd answer all count as OFF (`lib/integrations/xero/launch-hold.ts:15-22`). The app checks before any claim (`lib/integrations/server.ts:115-118`) and before every provider call (`launch-hold.ts:33-45`); the database claim judges it again (`supabase/release/149_xero_launch_hold.release.sql:236`).
- A held run returns `blocked: "launch_hold"`. The sweep still renews the Xero sign-in, counts the company as `renewed` and drops the `blocked` field, so the cron answer and its log line show `sent=0` with no reason (`lib/integrations/sweep.ts:24-31` reads only `sent/failed/needsCheck`). A held backlog is invisible in the cron output; it is visible only in the Admin > Integrations screens.
- Documents queued before the switch need an admin to approve each one with a fresh authenticator code: `GET/POST /api/integrations/xero/held` (`app/api/integrations/xero/held/route.ts:15-45`), UI `components/integrations/xero-held-review.tsx`.
- Is 149 applied in production: `supabase/applied-migrations.json` lists only migrations up to 095, and `supabase/release-plan.json:88-97` lists 149 as planned. Production state is **NOT VERIFIED**. If 149 is not applied, the code fails closed: nothing is sent and the cron answers a quiet `skipped` (`xero-pass.ts:22`).

Send log (where an admin sees Xero outcomes): table `public.integration_sends` (migration 084), screen Admin > Integrations > Send log (`components/xero-send-log.tsx`, columns at `lib/integrations/send-log.ts:11`), filter "problems" = failed + needs_check (`:70-73`), Retry is admin only after the second sign-in step (`:3-5`). Tolra support cannot use Xero routes: `auth.session?.support` is refused (`after-issue/route.ts:25`, `xero/held/route.ts:18`).

## 3. Support and security alerts

### 3.1 What is written, and where it can be read

| Record | Written by | Readable by | Screen / query | Evidence |
|---|---|---|---|---|
| `security_audit.audit_log` (hash-chained) | `write_audit` RPC. Browser callers post to `/api/audit`; failure is `console.error` only and is fire-and-forget (lost if the tab closes) | Company admin | Admin > Security (`app/(dashboard)/admin/compliance/page.tsx`, "Audit log" table with integrity code) | `app/api/audit/route.ts:43-60`; `lib/audit.ts:25-43` |
| Activity trail ("who did what") | `record_activity` / migration 013, 035 | Admin | Admin > Activity (`app/(dashboard)/admin/activity/page.tsx`), filter by person, record type, date | page lines 1-60 |
| Invite refusal log | `integration_invite_refusal_log` (server only, best effort) | **Nobody in the app.** Table has no grant to any role including `service_role`; "read by the database owner / platform operator" | SQL only (see 6.2) | `lib/integrations/invite.ts:141-153`; `supabase/release/151_xero_invite_hardening.release.sql:69-85, 462-498` |
| Correlation id of a refusal | random UUID, also printed on the public page and in the server log | Whoever sees the page | Quote the id, then look it up by SQL | `invite.ts:150`, `console.warn` at `:151` |
| Rate-limit hits | `auth_rate_hit` RPC into `public.auth_rate_limits` (hashed keys) | Operator by SQL only | none | `lib/server/login.ts:50`; migration 011 |
| Server error alerts | `reportServerError` | Owner mailbox in `ALERT_EMAIL_TO` | e-mail; budget table `security_audit.error_alerts` / `browser_error_alerts` | `error-alert.ts:73-98`; migrations 033, 115 |
| Send ledger for company e-mail | `reserve_company_email` / `complete_company_email` | Admin and office | Email history screen (status `sent_via_system`, `failed`, `unknown`, `drafted`) | `send-company-email.ts:218-246` |
| AI helper requests | `reserve` / `settle` RPCs, `public.ai_helper_requests` | Admin | AI section | `lib/ai-helper/server.ts:90-103` |

"dev001 held alert": in the code this is only a user-facing sentence. `lib/friendly-error.ts:78` and `:80` map the database hints `dln_numbering_not_set` and `company_on_hold` to plain staff wording. Contract test: `tests/unit/dev001-held-alert.test.ts`. It does not notify anyone; staff see it in the form that was refused. Which database function raises `company_on_hold` is **NOT VERIFIED** (not searched beyond the mapping and its test).

### 3.2 Who sees what

- Company admin: Admin > Security (audit log, "Send test alert"), Admin > Activity, Admin > Integrations (status, mappings, send log, held list), sync chip in the top bar for the offline outbox (`components/sync-status.tsx`).
- Office and workshop: the sync chip and their own error messages. Office sees Email history. They do not see the Xero send log (`send-log.ts:1-3`).
- Tolra support / platform owner: `app/platform/page.tsx` lists companies (`platform_list_organizations`, line 48) and can enter one with a reason and hours (`platform_enter_organization`, line 98). Inside a company support is refused on Xero, alert-test and held routes (`app/api/admin/alert-test/route.ts:19`). There is no platform-wide health, error or job dashboard in the app. A support banner exists (`components/support-banner.tsx`).
- "Send test alert" (Admin > Security): `POST /api/admin/alert-test` raises a made-up error through the real path. If `ALERT_EMAIL_TO` is unset or the deployment is not production it answers `disabled` / `not-production` (`alert-test/route.ts:28-30`). Second run within the hour is `rate-limited` by design.

### 3.3 Outbound alerting

**The only one is the owner e-mail through Resend.** NONE for Slack, webhook, SMS or push.

- It needs `ALERT_EMAIL_TO`, `RESEND_API_KEY` and `EMAIL_FROM` in Production (`error-alert.ts:58-61, 102-107`). All **NOT VERIFIED**.
- Budget: one e-mail per fingerprint per hour and 20 a day, counted in the database; browser reports 5 per person, 10 per company, 20 in all per day (`error-alert.ts:44-47`, `lib/error-alert.ts:12-17`). One noisy outage can use up the day's 20 and hide a later, different failure. Fingerprints collapse digits and ids (`lib/error-alert.ts:60-66`).
- Same mail path as the product's own e-mail: if Resend is down or the sender domain is unverified, the alert is lost with only a log line (`error-alert.ts:131-133`).
- What it sends: route, redacted message (max 300 characters), commit (12 chars), time, fingerprint. No body, cookie, header or user (`error-alert.ts:114-122`, `lib/error-alert.ts:1-6`).
- Page crashes: `app/error.tsx` and `app/global-error.tsx` call `reportClientError` (`app/error.tsx:15`), which posts to `/api/report-error`. Signed-in people only (`report-error/route.ts:64-65`), so a crash on the sign-in page itself is never reported.

## 4. Logging hygiene

Method: listed every `console.error/log/warn/info` in `app/api`, `lib`, `middleware.ts`, `instrumentation.ts` (186 lines) and searched them for token, secret, key, password, authorization, cookie, bearer, code, verifier, jwt, message, body, subject, e-mail.

Result: no line prints a token, secret, key, password, cookie, authorization header, one-time code or verifier. Most log a database error code or an error class name only. Cron secret: never logged (`cron-auth.ts:13`). Invite references: only a 16-character hash (`invite.ts:137, 151`). Alerts are redacted of JWTs, bearer strings, key=value pairs, e-mails, UUIDs, 32+ character tokens and phone numbers (`lib/error-alert.ts:16-44`).

Items worth a person looking at (not secrets, not fixed here):
1. `app/api/platform/organizations/route.ts:63` writes a JSON line with actor user id, new company id, slug and client IP at `console.info`. Identifying data in the platform log, not a secret.
2. `app/api/admin/users/route.ts:79` logs up to 200 characters of a database error `message`; `app/api/platform/organizations/route.ts:50` logs 120. A Postgres message can quote a value. Low risk.
3. `app/api/ai-helper/assistant/route.ts:52` logs `error.message` in full.
4. `lib/company.ts:317` logs the whole `err` object for a logo load failure.
5. `lib/audit.ts:43`, `lib/company.ts:317` run in the browser console, not the server log (`lib/audit.ts` is a client module).
6. Anything printed by `console.error` in a client component (`components/`) was not searched. **NOT VERIFIED**.
7. Vercel log retention and who can read runtime logs: **NOT VERIFIED**.

## 5. Health endpoints, error pages, rate limits

Health:
- `GET /api/health` (no sign-in): healthy only when the auth service `/auth/v1/health` answers and a pure SQL function (`booking_day_plan_ok`) runs; 5 s timeout each; 200 or 503; returns only `{ ok, database }` (`app/api/health/route.ts:10-43`). It does not check Xero, Microsoft, Resend, Anthropic, storage, cron freshness or queue depth.
- Nothing in the repo calls it on a schedule (see section 0).

Error pages: `app/error.tsx`, `app/global-error.tsx`, `app/(dashboard)/error.tsx`, `app/not-found.tsx`, `app/configuration-error/page.tsx` (code `AUTH_CONFIG_MISSING`), `app/offline.html`. The error screen shows a Next "Error reference" digest (`app/error.tsx:26`); that digest is also in the owner alert text (`report-error/route.ts:72`), so a user's quoted reference can be matched to an alert. Server errors: `instrumentation.ts:9-12` forwards every unhandled route, page or action error to the alert path.

Rate limits (all through `auth_rate_hit`, fail closed when the limiter is unavailable: `lib/server/login.ts:36-62`):

| Surface | Limit | Evidence |
|---|---|---|
| Sign-in | per IP, per account+IP failures, per account failures | `app/api/auth/signin/route.ts:59, 104-105` |
| Password reset | per IP and per identifier (10 and 3) | `app/api/auth/reset/route.ts:38-39` |
| Admin reset link | per admin and per person | `app/api/admin/users/reset-link/route.ts:67-68` |
| New company (platform) | per user per hour | `app/api/platform/organizations/route.ts:25` |
| Public Xero invite routes | 20 per 15 min per IP, **refuse when limiter down** | `lib/integrations/invite.ts:114-132` |
| Xero picker claim | one use per offer, uses `integration_xero_picker_claim` | `app/api/integrations/xero/choose/route.ts:65`; `login.ts:50` |
| Admin-consent state use | one use | `lib/integrations/signed-state.ts:81` |
| Company e-mail | 200 per hour per company | `send-company-email.ts:76` |
| AI helper | monthly cap per company | `lib/ai-helper/server.ts:36` |
| Browser error reports | small separate budget | `error-alert.ts:44-47` |

Limiter failures print `[login] rate limiter unavailable` to the server log but send no alert (`login.ts:41, 52, 56`), and the public pages simply say try again.

IP source: the limiter uses `x-real-ip` else the last `x-forwarded-for` hop (`login.ts:20-23`). Correct behind Vercel; behind any other proxy it would be wrong. Deployment topology: **NOT VERIFIED**.

## 6. Operator checks on cutover day (existing screens and read-only SQL only)

### 6.1 Screens and routes

| Check | Where | What good looks like |
|---|---|---|
| App and database reachable | Open `/api/health` in a browser (public) | `{"ok":true,"database":true}`, HTTP 200 |
| Alert path works end to end | Admin > Security > "Send test alert" (admin only, not support) | "sent". `disabled` or `not-production` means `ALERT_EMAIL_TO` is not set or the deployment is not Production. `rate-limited` means one went in the last hour: look in the inbox and spam |
| Xero connection | Admin > Integrations | "Connected", nothing under "Nothing is sent until these are mapped" (`overview.ts:34-52`) |
| Xero send queue | Admin > Integrations > Send log, filter "Problems" | zero failed and zero "Check in Xero" |
| Xero held documents | Admin > Integrations held review (`components/integrations/xero-held-review.tsx`) | list empty, or each item deliberately approved |
| Microsoft 365 mail | Admin > Integrations Microsoft card (`components/microsoft-connect-card.tsx`), "Test" | connected; reading status not `needs_reconnect` or `failed` |
| Resend | Admin > Integrations Resend card and its test-send (`app/api/integrations/resend/test-send/route.ts`) | accepted |
| Outgoing e-mail | Email history screen | statuses `sent_via_system`; none `failed` or `unknown` |
| Who did what | Admin > Activity; Admin > Security audit log | expected actors and times |
| Offline outbox | top bar sync chip | "Online and synced" |
| Cron runs | Vercel project > Cron Jobs / runtime logs for `/api/cron/daily` and `/api/cron/nightly` | **NOT VERIFIED** (outside the repo; read-only in the Vercel UI) |

### 6.2 Read-only SQL (Supabase SQL editor, owner role). Run only by a person; none was run for this document

Table and column names were taken from the migrations cited; exact column names should be confirmed against the live schema before use (**NOT VERIFIED** against production).

```sql
-- Xero queue by status, per company (084 integration_sends)
SELECT organization_id, status, count(*) FROM public.integration_sends GROUP BY 1,2 ORDER BY 1,2;
-- Anything stuck or failed in the last 7 days (no tokens in this table)
SELECT organization_id, doc_type, doc_ref, status, attempts, last_error, updated_at
  FROM public.integration_sends WHERE status IN ('failed','needs_check') OR (status IN ('pending','sending') AND updated_at < now() - interval '1 day')
  ORDER BY updated_at DESC LIMIT 100;
-- Connections that need attention (columns as in 084; no secret table touched)
SELECT organization_id, provider, status, status_reason FROM public.integration_connections WHERE status <> 'connected';
-- Release 149 switch state (the verifier file supabase/verify/xero_launch_hold_149.sql is also read-only)
SELECT organization_id, enabled, reason, changed_at FROM public.xero_transfer_hold;
-- Company e-mail outcomes, last day
SELECT status, count(*) FROM public.email_history WHERE created_at > now() - interval '1 day' GROUP BY 1;
-- E-mail schedule runs (108)
SELECT * FROM public.email_schedule_runs ORDER BY 1 DESC LIMIT 20;
-- Invite refusals, last day (151; security_audit schema, owner only)
SELECT created_at, correlation_id, step, reason, organization_id FROM security_audit.integration_invite_refusals WHERE created_at > now() - interval '1 day' ORDER BY id DESC;
-- Alert budget used today (033, 115)
SELECT count(*) FROM security_audit.error_alerts WHERE created_at > now() - interval '1 day';
-- Rate-limit pressure by bucket, last hour (hashed keys only)
SELECT bucket, count(*) FROM public.auth_rate_limits WHERE created_at > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC;
```

The repository also holds read-only verifiers: `supabase/verify/xero_launch_hold_149.sql`, `supabase/verify/xero_invite_hardening_151.sql`, `supabase/verify/release_preflight.sql`. Each states it is read only; run through the release route in `Tolra Progress.md`, not ad hoc.

## 7. Gaps, ranked by risk

Risk = chance it happens on go-live week times how long it stays unseen. Mitigations are manual checklist steps only. "Option for Rhys" lines are code ideas, not done and not recommended without a separate decision.

| # | Gap | Evidence | Risk | Minimal manual mitigation | Option for Rhys (not done) |
|---|---|---|---|---|---|
| G1 | No uptime check in the repo; only the owner e-mail and the public health URL. A full outage (Vercel, Supabase) produces no alert at all because errors need a running app and Resend | `health/route.ts:5` names a missing workflow and doc; only `ci.yml` exists | High | Rhys or the operator opens `/api/health` at set times on 12 Nov (morning, noon, close). Register the URL in a free external pinger by hand (outside the repo) | Add the scheduled workflow the code already names |
| G2 | Counted failures never alert. A sweep with `failed`, `needsCheck`, `errors` or `needsReconnect` above zero, or e-mail schedules with `failed`/`errors`, answers 200 and only writes a log line | `pass.ts:15`; `xero-pass.ts:25`; `daily/route.ts:37` | High | Each morning after 06:00 UK, look at Admin > Integrations Send log "Problems" and Email history for `failed`/`unknown`; check Vercel log for the `[cron/xero-sweep]` and `[cron/email-schedules]` lines | Alert when any of those counts is above zero |
| G3 | A silent `skipped` hides an unapplied migration (084, 108, 116, 127, 133, 149): crons return 200 and do nothing | `xero-pass.ts:20-22`; `overview-snapshot/route.ts:130-133`; `mail-poll/route.ts:28` | High | After each release step run the matching `supabase/verify/*.sql` through the release route and tick it off; do not rely on the cron | Alert on `skipped` once the release plan says the migration is live |
| G4 | `CRON_SECRET` unset or short = every cron refuses with 401 and no alert. Applied state of secrets **NOT VERIFIED** | `cron-auth.ts:5, 15-16` | High | Before 12 Nov confirm in the Vercel Production environment that `CRON_SECRET` exists (16+ characters) and `ALERT_EMAIL_TO`, `RESEND_API_KEY`, `EMAIL_FROM` exist. Do not paste values anywhere. Press "Send test alert" and confirm the e-mail arrives | none needed |
| G5 | Alert e-mail is the only channel, shares Resend with the product, is capped at 20 a day and one per fingerprint per hour, and goes to a mailbox someone must watch. Alerts are lost (log line only) if Resend fails | `error-alert.ts:52, 128-134`; `lib/error-alert.ts:12-17` | High | Name who watches the `ALERT_EMAIL_TO` mailbox and when on 12 Nov and the days after. Check spam. Re-run "Send test alert" after the final deploy | A second channel (webhook) |
| G6 | Held Xero backlog is invisible in cron output (`blocked` dropped) and in alerts. A forgotten held list means invoices never reach Xero with no notice | `sweep.ts:24-31`; `launch-hold.ts:15-22`; `xero/held/route.ts:15-22` | Medium-High | Admin checks Admin > Integrations held review and Send log counts at close of day on 12 Nov and each day of the first week; compare with invoices issued | Surface `blocked` in the sweep summary and alert on a non-zero held count |
| G7 | Xero retries are effectively daily (Hobby), 6 attempts, so a transient failure can leave an invoice unsent for days with no one told. Browser nudge is best effort | `engine.ts:19-25, 160`; `nudge.ts:9-21`; `daily/route.ts:17` | Medium-High | Admin presses "Send now" after the day's invoicing and again before close; look for "Check in Xero" rows | Move to the Pro plan cron variant described in `daily/route.ts:26-31` |
| G8 | No overall time budget in the Xero sweep across companies; a function killed at 60 s leaves no alert and a row mid-send (becomes `needs_check`, never sent twice per the comment) | `sweep.ts:21-37`; `daily/route.ts:10`; `send/route.ts:8-10` | Medium (low with one connected company) | Count connected companies before go-live; if more than a few, run "Send now" per company during the day | Add a budget to the sweep |
| G9 | Microsoft inbox reading has no server schedule: nobody with a visible tab means no reading; `mail-poll` is not in `vercel.json` | `mail-poll/route.ts:19-20`; `inbox-auto-check.ts:3-8` | Medium | Tell the office to keep one tab open on 12 Nov; check the Microsoft card status; Option: manual "Check now" if present (**NOT VERIFIED** whether one exists) | Schedule `mail-poll` on a Pro plan |
| G10 | No screen for the invite refusal log or rate-limit data; SQL by the database owner only. A support call quoting a correlation id needs someone with owner access | `151_xero_invite_hardening.release.sql:69-85`; `invite.ts:150` | Medium | Keep the 6.2 SQL ready for the operator with owner access; ask the caller for the correlation id shown on the page | Read-only platform screen |
| G11 | Platform / Tolra support has no cross-company view of errors, jobs or queues. Support cannot use Xero routes by design | `app/platform/page.tsx:48, 98`; `after-issue/route.ts:25` | Medium | Support triages from the owner alert mailbox and, per company, asks the admin to read the Send log | none |
| G12 | Supabase service client has no request timeout; a hung database call runs until the Vercel 60 s limit and then dies unreported | `lib/server/supabase-admin.ts:16`; `resilient-fetch.ts:33-42` | Medium | Watch `/api/health` (it times out at 5 s) as the early signal; note that user-facing slowness will not alert | Add an abort signal to the fetch wrapper |
| G13 | Backups and capacity checks are referenced but their workflows are not in this tree; whether nightly backups run is unknown | `scripts/backup-run.sh:2, 23`; `scripts/capacity-check.mjs:3`; `.github/workflows/` has only `ci.yml` | Medium (high consequence) | Before 12 Nov confirm in GitHub Actions and the backup store that the last nightly backup exists and decrypts (outside this repo). Treat as **NOT VERIFIED** until a person does | none |
| G14 | Browser error reports need a signed-in user; a crash on the sign-in page or before the session is established reaches nobody | `app/api/report-error/route.ts:64-65` | Low-Medium | Operator signs in once from a clean browser after each deploy | none |
| G15 | Audit events from the browser are fire-and-forget and lost if the tab closes or the call fails (`console.error` only) | `lib/audit.ts:25-43` | Low-Medium | Spot-check Admin > Activity against actions taken in the cutover rehearsal | Move the write server-side |
| G16 | A few log lines carry identifiers or database message text (section 4 items 1 to 4) | `platform/organizations/route.ts:50, 63`; `admin/users/route.ts:79`; `ai-helper/assistant/route.ts:52`; `lib/company.ts:317` | Low | Limit who can read Vercel runtime logs (**NOT VERIFIED** who can) | Trim the messages |
| G17 | Invite refusal table retention (180 days) has no purge job | `151_..._release.sql:69-70` | Low for go-live | Calendar a manual purge after 180 days | Add to nightly job |

## 8. Top 10 gaps (for the hand-off)

G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, as in section 7 with the file:line given there.

## 9. NOT VERIFIED (cannot be established from the repository)

1. Production environment variables: `CRON_SECRET`, `ALERT_EMAIL_TO`, `RESEND_API_KEY`, `EMAIL_FROM`, `SUPABASE_SERVICE_ROLE_KEY`, Xero and Microsoft app credentials, and `REQUIRE_ADMIN_MFA`.
2. Which migrations are applied in production. `supabase/applied-migrations.json` stops at 095; 108, 115, 116, 127, 133, 138, 149, 150, 151 are in the release plan but their live state is unknown.
3. Vercel plan (the code says Hobby), whether Vercel notifies on failed cron invocations, log retention, and who can read runtime logs.
4. Whether `nightly-backup.yml`, `uptime-check.yml`, the capacity workflow, `docs/MONITORING.md` and `docs/RESTORE.md` exist outside this tree, and whether nightly backups actually ran.
5. Whether any external uptime pinger is already registered for `/api/health`.
6. Which database function raises the `company_on_hold` hint (only its message mapping and test were read).
7. Exact column names in the SQL of 6.2 against the live schema (taken from migration files, not run).
8. The line-level cron guard of `app/api/cron/ai-helper-purge/route.ts` (header lines only were read).
9. Client-side `console.*` in `components/` and `app/**/page.tsx`.
10. Whether the Microsoft inbox card has a manual "Check now" button.
11. Real behaviour under load: Xero overlap, 429 handling, timeouts and the 60 s limit were read, not exercised.
12. Whether the mailbox behind `ALERT_EMAIL_TO` is watched, and whether Resend's sender domain is verified.
13. Number of companies connected to Xero at go-live (decides how much G8 matters).
14. IP source behind the production proxy for the rate limiter.

DRAFT - findings only, not approved.
