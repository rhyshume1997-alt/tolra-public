> Historical snapshot: code findings updated in BUILDER2-FINAL-COORDINATION.md and fixes #144–147. Keep this evidence; use the final coordination report for current status.

# Builder 2: integration handover

Prepared 2 November 2026. JNR's first day is Thursday 12 November. The build
cutoff is Friday 6 November. These are draft PRs for review, not production
sign-off. Builder2 has not merged, deployed or applied a database migration.

The complete job table is [CHATGPT-BUILD-HANDOVER-2.md](CHATGPT-BUILD-HANDOVER-2.md).
The ownership table preserves the other builders' entries and adds builder2's
numbered queue. Original builders' branches were not changed.

## Review order and dependencies

| Work | PRs | Base / integration note |
| --- | --- | --- |
| Original settings / approval / payment claim cards | #111, #112, #113 | Props components only. All now draft. Consolidate with #132 rather than merging duplicate copies blindly. |
| Original SliQ tests / staff guide | #114, #115 | #139 corrects the guide's pricing example. |
| Chase page wiring | #132 | Into claude/chase-steps. Uses its existing run/approve routes and claim RPCs. See its chase-wiring-notes.md. |
| JNR first-day checklist | #133 | Into main. JNR must fill the contact card. |
| Chase browser specs | #134 | Into chatgpt2/chase-wiring. Updates the original chase assertions for the new card and adds new flows. |
| Review and costing fixes | #135 | Into chatgpt/costing-wiring (#123). Fixes render exceptions and rounded quote-line preview totals. |
| Bank formats | #136 | Into chatgpt/bank-matcher-more-tests (#120). Fifteen pre-fix failures; includes the quote guard also in #131. Consolidate that overlap. |
| UK payment emails | #137 | Into chatgpt/paid-claim (#107). Reconcile the copied detector in #117. |
| Receivables and pence | #138 | Into main. Invalid overdue dates return unknown; money rounding is unchanged. |
| Plain English | #139 | Into chatgpt2/pr-review. Copies props components for review; align changes with the chase and bank integration branches. |
| Costing browser smoke | #140 | Into chatgpt2/plain-english-pass. Requires costing migration 143 in the disposable test stack. |
| Timesheet schedule tests | #141 | Into claude/e13-timesheet-days. No implementation or migration edits. |
| Whole-suite evidence | #142 | Into main. Blocked, not a green suite. |
| Final tracker and handover | This PR | Into main. Copies the report files from #142 and review table from #135 for one readable handover; consolidate duplicate docs during integration. |

## Checks actually observed

- Chase wiring: 13 new adapter cases reported passing; TypeScript and targeted
  ESLint passed.
- Chase browser runner: nine tests cleanly skipped because no disposable
  database was configured. These are not nine passing browser tests.
- Costing review: seven new regressions reported passing; TypeScript and ESLint
  passed. Existing engine parity tests were not weakened or rewritten.
- Bank formats: 15 failures reproduced before the fix; all 16 new cases then
  reported passing. TypeScript and ESLint passed.
- Payment emails: 21 failures reproduced before the fix; 30 new plus 39 original
  cases then reported passing. TypeScript and ESLint passed.
- Receivables: five invalid-date failures reproduced; 40 new plus nine original
  cases then reported passing. TypeScript and ESLint passed.
- Wording: four new and three existing render cases reported passing.
- Costing browser runner: two tests cleanly skipped without the database.
- Timesheets: 95 cases reported passing across the three selected files; the
  final new-file check reported 25/25. TypeScript and ESLint passed.
- Full suite: [17 bounded attempts](BUILDER2-FULL-SUITE-RUN.md), including main
  and every published source branch. No clean whole-suite pass. Failed counts,
  skips, missing files, commit IDs, signals and diagnostics are preserved.
  Full-suite assertion failures are listed, not hidden or labelled green.

Focused Vitest runs commonly reported their cases but stayed open afterwards.
The whole-suite workaround exposed temporary-folder and shared-state problems;
representative files pass separately. That evidence does not replace a clean
run on the supported CI runtime.

## Still open before release

1. **Clean CI and real browser/database checks.** No Ready label has been added
   by builder2. No database or mail provider was available here. The integration
   owner must test the exact consolidated commit and keep the existing gates.
2. **Database setup.** The relevant bases refer to migrations 138 (chasing and
   payment claims), 142 (timesheet days), and 143 (costing rates). Builder2 did not
   create or apply those migrations. Claude owns database review/application.
3. **Atomic settings and concurrent edits.** Chase settings and costing settings
   still save through several requests. A partial save can occur. Chase wiring
   blocks another save until reload after failure; an atomic RPC and a version
   check remain database work. Draft approval also lacks a reviewed-text version
   precondition against concurrent edits.
4. **Payment-claim form reopening.** The wired Confirm payment received action
   opens Record payment and keeps chasing paused until a receipt is saved. The
   generic completed-action lock can leave that button disabled after cancelling
   the form; reload currently allows reopening. This needs a small wiring fix
   and its live browser assertion before release. A failed claim clear after a
   saved receipt must never result in recording that receipt again.
5. **Customer matching.** Same-name customers are ambiguous; the approval wrapper
   refuses to guess which customer to pause. A durable customer ID is preferable.
6. **Costing machine labour override.** #123's mapping drops a machine-specific
   labour rate and uses the company rate. This was commented on and remains
   unfixed. The markup wording correction does not change pricing maths.
7. **Bank confirmation persistence.** #116's callback still hides the row before
   an asynchronous payment save has succeeded. It needs pending/error handling
   and server idempotency before a real payment handler is connected. The matcher
   also still needs a short-reference-versus-long-reference safeguard; #136 only
   fixes the CSV parser.
8. **Email sender evidence.** #117's blank sender / blank customer-email match is
   still open. All suggestions need company-scoped inputs and human checking;
   a message is never proof that cash arrived.
9. **Staff guidance.** Reconcile #115 with #139, fill JNR's contact names/numbers,
   and check the final screen labels. Timesheet day-selection UI from Claude's
   branch supersedes the older weekly/once instructions after integration.

The [PR review matrix](BUILDER2-PR-REVIEW.md) preserves the source findings and
reviewed commits. No claim is made that other builders have accepted these
findings or that any of the above has been fixed in production.
