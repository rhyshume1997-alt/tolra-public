# Builder 4: email, recent MFA and provider cards on PR #415

Base: `e42d927383513d1b98ce9cfca444884475622e2f` (PR #415, `cand/12nov-int`).
Own branch: `codex/b4-415-email-mfa-review`. One draft PR into the candidate; Code integrates it. No merge, production SQL, live provider calls or customer messages.

## Already present and reused

DONE in the pinned candidate: scheduled chase drafts, human approval, atomic draft send claims, unknown-outcome holds, send audit/recovery, company token encryption, Xero/Microsoft forced recent MFA, and provider cards with no sending switch. These were exercised rather than replaced. Existing quote, job, invoice, statement, reminder, supplier/internal and RFQ tests remain in the unit suite.

## Reproduced and fixed

- Chase approval checked the displayed subject and body but not the displayed recipient. A stored change to another allowed team address could send to that address without the person's approval. `expected_to` now travels from both approval UIs through the strict route schema and the guard, alongside the exact subject and body. Old clients lacking the reviewed address fail closed.
- Unavailable pause/recipient reads could be treated as empty lists. They now refuse sending. Pauses and customers use the existing `fetchAll`, preserving smaller API caps and refusing truncated checks; a pause after page one is no longer missed.
- A payment, pause or dispute recorded during provider lookup was not rechecked. The same eligibility check runs again after the draft is claimed and before sending. Refusal releases the claim without sending and records the change. Disputes use the existing pause-with-reason control; this app does not have a separate `disputed` invoice status.
- Chase approval selected the provider twice. The checked provider is now passed to the existing mailer. Provider selection fails closed for a Microsoft connection needing reconnection, unavailable app credentials/token, unreadable connection state or absent service client. Configured Resend is eligible only when this company has no Microsoft connection or an admin explicitly disconnected it. The legacy inbox reader's existing null result is preserved; the stricter mode is used for sending.
- Saving/replacing an AI key bypassed recent MFA when the global MFA flag was off. It now uses `requireRecentAal2(..., true)`, as Xero and Microsoft connect/disconnect already do. Existing switch-off/key-removal policy stays available.
- Resend called unverified configuration “ready”; a second, stale Microsoft overview could also leave its card misleading after disconnect/reconnection. The cards share the Microsoft card's latest state, including failed reads. Resend shows “set up, not yet verified”, or a hold while Microsoft needs attention. A failed Microsoft test refreshes the stored connection and does not leave “Sending: ready”. Both cards explicitly require a person to send or approve each message, without a fake switch.
- The sender parser accepted incomplete angle brackets and silently stripped header controls. One shared parser now rejects those settings in both status and provider selection, before creating a Resend provider.

## Validation

Final full unit suite: **6,662 passed, 0 failed, 0 skipped, 456 files**, 174.45 seconds. Lint: **0 errors, 14 existing warnings**. Final typecheck: **passed** with the explicit 6 GB Node heap. Focused new/reworked regression selection: **205 passed in 5 files**, 3.67 seconds.

Focused proof includes 95 cases through the real authentication and recent-MFA guards (mocked Supabase transport/provider side effects): stale, absent, malformed and out-of-window future MFA; aal1/auth errors; office/workshop/read-only/support/inactive refusals; database role refusal and mismatched company; secondary-admin success; session company over stale profile/body/header company; AI ciphertext cannot decrypt in the other company. The helper under test is not mocked.

App route proof: 19 passing mock-backed tests through the real chase HTTP handler and browser request builder. They cover exact recipient/subject/body, stale edits, missing recipient approval, company/role restrictions, paid/credited/paused/disputed exclusions, overlapping sends, unknown holds/audits, and no provider fallback. These are route integration tests, not database/browser E2E.

Scheduler proof: existing `cron-daily.test.ts` (14 passing) and `cron-email-schedules.test.ts` (16 passing) call the real authenticated GET handlers, schedule runner and draft generator, with a fake database RPC. They generate drafts with no browser, send nothing, scope both companies and avoid repeat drafts. `vercel.json` already schedules `/api/cron/daily` at `0 5 * * *`. This proves the controlled server entry point, not that a hosted cron has fired.

Database/browser limitations, recorded separately from passes:

- `vitest run -c vitest.db.config.ts tests/db/reviewer-chase-conditions.test.ts`: 6 failures, all at the backend identity guard because `TEST_SUPABASE_URL` is absent, before SQL or provider calls. The existing DB scenarios were updated for recipient binding and one real-DB recipient regression was added; execution remains blocked.
- Standard Playwright chase/controls/schedule selection: 16 tests collected across 3 files; global setup fails on the same missing isolated backend. No browser scenario ran.
- Existing optional reviewer browser runner: 4 skipped, 0 passed. These skips are not proof.
- The local Supabase startup attempt is already recorded in `work/email-backend-start.log`: the environment's network policy refuses `public.ecr.aws` when Docker requests the pinned Supabase Postgres image. No hosted or production backend was substituted.
- Initial red regressions were used to reproduce the defects, then fixed. During verification, typecheck first exhausted Node's default 2 GB heap; the final command uses `node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit`. Test fixture/type errors found during the change were corrected. No checks were disabled.

Commands: full units `node node_modules/vitest/vitest.mjs run`; lint `node node_modules/eslint/bin/eslint.js . --no-eslintrc --config .eslintrc.json --ext .js,.jsx,.ts,.tsx` (explicit project config avoids the outer worktree's duplicate Next plugin); typecheck as above. Logs stay outside this worktree in `work/review415-*.log`.

## Status and integration handover

Email approval, exclusion/claim safety, MFA and card changes: CODED; mock/DOM/route TESTED after the final unit pass. No claim of CONNECTED, MERGED, DEPLOYED or LIVE VERIFIED. Existing provider setup is ready for keys/connection, subject to its external settings and isolated DB/browser proof.

External configuration remains the existing Microsoft app client ID/secret, exact callback URL, encryption key and per-company delegated mailbox consent (Mail.Send; Mail.Read for intake), or Resend API key plus a provider-verified `EMAIL_FROM` domain. Hosted scheduled generation needs the existing `CRON_SECRET` and deployed cron. No external configuration was changed or tested here.

Estimated integration: 45–60 minutes of Code/Opus review and integration if the pinned base is unchanged, plus the existing isolated DB/browser runner time. No new migration or SQL deployment step. Ship the approval UI and `expected_to` API contract together; a stale tab must reload rather than infer approval from the database. Merge nothing from this worktree automatically.

Overlap for Opus: the changes touch the candidate's AI key-save route, shared Microsoft token source and the three integration-card files. Coordinate any concurrent edits to those exact files rather than replaying this patch over Code's work. No other agent branch or PR #415 was edited. No unverified changes from the earlier #413 worktree were copied in.

## Exact changed files

- `app/(dashboard)/approval/page.tsx`
- `app/api/ai-helper/key/route.ts`
- `app/api/chase/approve/route.ts`
- `components/chase/approval-card.tsx`
- `components/chase/connected-approval.tsx`
- `components/integrations/integrations-overview.tsx`
- `components/integrations/microsoft-setup-card.tsx`
- `components/integrations/resend-setup-card.tsx`
- `docs/handover/BUILDER-4-415-EMAIL-MFA-REVIEW.md`
- `lib/chase/ui-store.ts`
- `lib/email/chase/approve.ts`
- `lib/email/resend-status.ts`
- `lib/email/send-company-email.ts`
- `lib/email/sender.ts`
- `lib/integrations/microsoft/token-source.ts`
- `tests/db/reviewer-chase-conditions.test.ts`
- `tests/e2e/reviewer/chase.spec.ts`
- `tests/unit/ai-helper-routes.test.ts`
- `tests/unit/b4-chase-route-flow.test.ts`
- `tests/unit/b4-provider-selection.test.ts`
- `tests/unit/b4-sensitive-route-boundaries.test.ts`
- `tests/unit/chase-approval-ui.test.ts`
- `tests/unit/chase-approve.test.ts`
- `tests/unit/chase-customer-review.test.ts`
- `tests/unit/chase-reviewed-text.test.ts`
- `tests/unit/chase-ui-wiring.test.ts`
- `tests/unit/f1-ai-routes-mfa.test.ts`
- `tests/unit/f3-cards.test.ts`
- `tests/unit/mailbox-delegated.test.ts`
- `tests/unit/resend-status.test.ts`
- `tests/unit/wa-provider-and-routes.test.ts`
- `tests/unit/wm-ms-isolation.test.ts`
