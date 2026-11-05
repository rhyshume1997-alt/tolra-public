# EMAIL — customer-facing workflow handover

Builder 4, 5 November 2026. Draft #413 is based on main `68f89ca7b801a10587ff9b51d6c820462847b65a`; it no longer needs a dependency on #407.

**Provider setup belongs to Claude Code Sonnet in #407.** This change does not add or alter its Resend configuration/status screen, Microsoft connection/consent, encryption, token refresh or reconnection implementation. No provider adapter/configuration files are changed against main. #407, #359, the go-live branch and other agents' branches are untouched. The final diff contains only workflow code, its tests and this handover.

## DONE / retained workflow work

- Existing quote, invoice, purchase-order/supplier and delivery-note email screens already call the shared company mailer after a person's send action. These paths are reused, not duplicated.
- Job emails now select the configured provider through that same gateway while retaining the original job quota/idempotency ledger. They use the existing shared input and preview-recipient checks. A lost outcome write is reported as unknown.
- RFQ reply/forward uses the active company's already configured delegated token and `/me` through the existing Graph actions/mail ledger. It does not create a Microsoft connection or change token renewal. Existing legacy single-company operation remains available when no delegated connection is supplied. Support sessions and empty preview allowlists are refused. A send-time 409 is uncertain, not automatically retryable.
- Customer-facing scheduled document/reminder kinds without a human actor always become drafts, even with a configured provider. Existing internal timesheet/reopen notifications retain their internal scheduling and company-mailer paths. Platform error alerts retain their existing platform Resend path; no company is guessed for them.
- **Customers → Draft statement** reads only the session company's data, uses existing receivables/pence rules, lists confirmed outstanding invoices and unallocated credit separately, and saves a draft. It rejects ambiguous names, invalid amounts and incomplete results. It never changes invoices, payments or balances.
- The existing **Approvals → Full preview → Approve and send** explicitly approves supported statement/baseline-reminder drafts. The server compares exact saved subject/body/recipient, rechecks current financial/address facts, claims once with a conditional update and uses the existing send ledger with a stable key. Concurrent changes/approvals lose the claim and send nothing.
- Known provider refusal permits a reviewed retry with the same ledger key. Unknown results, thrown sends and failed outcome recording remain held rather than resent. The accepted history retains exact text and the approving user; the superseded draft is removed only after recorded success.
- Where modern chase tables exist, the generic reminder handler refuses and defers to **#233's existing chase approval controls**, retaining its pause/claim rules. This is not a second chase workflow. Existing manual Copy/Open email/Mark sent controls remain for unsupported or edited legacy drafts.
- Unexpected provider-selection errors fail the workflow without silently switching senders. Normal provider configuration, token/reconnect state and provider outcome classification remain owned by the configured-provider implementation.

## Workflow readiness

All rows below are CODED and TESTED with local mocks. READY means ready to use the configured providers, not connected/deployed/live evidence.

| Feature | Workflow status |
| --- | --- |
| Quote and invoice emails | DONE existing send workflow; shared gateway retained |
| Job emails | CODED / TESTED / READY FOR CONFIGURED PROVIDER |
| Supplier/document emails | DONE existing company-mailer workflow |
| Customer statements | CODED / TESTED / DRAFT + HUMAN APPROVAL |
| Payment reminders | CODED / TESTED / DRAFT + HUMAN APPROVAL; modern chasing retains #233 |
| RFQ intake and approved replies/forwards | DONE existing intake; CODED / TESTED delegated workflow bridge |
| Internal notifications | DONE existing paths; customer draft restriction does not reclassify internal schedules |

CONNECTED: not attempted. MERGED: no new work merged. DEPLOYED: not performed/verified by this task. LIVE VERIFIED: no. Provider setup and its exact keys/consent/admin-status controls remain with #407; do not reproduce or alter them here. Existing send-ledger/intake/schedule schema contracts are prerequisites, not SQL applied by this task.

## Validation and handover

Final workflow-only validation:

- **5,141 passed / 373 files; 0 failed, 0 skipped; 159.48 seconds**, exit 0 (`node node_modules/vitest/vitest.mjs run`).
- Focused workflow tests: **146 passed / 5 files**, 0 failed/skipped, 3.29 seconds.
- Typecheck passed, exit 0 (`node node_modules/typescript/bin/tsc --noEmit`).
- Full JS/TS lint passed, **0 errors / 12 pre-existing warnings**, exit 0 (`node node_modules/eslint/bin/eslint.js . --no-eslintrc --config .eslintrc.json --ext .js,.jsx,.ts,.tsx`). The unchanged project config is explicit to avoid the parent checkout's duplicate plugin; no rule was weakened.
- Whitespace and final ownership-boundary comparisons passed. No provider setup, connection, token-source, adapter or admin-status file is changed against main.

Tests use synthetic `.test` recipients, fake keys/tokens and mocked provider clients. Workflow tests cover statement creation and both providers, exact reviewed text, current balances/address changes, two-company isolation, concurrent edits/approvals, refusals, timeout/network/unknown outcomes and lost outcome recording. They preserve invoice rows. These are code/mock proofs, not an executed database/RLS concurrency or live-delivery proof.

The installed Next package has no bundled docs directory; the official v15.5.28 route-handler reference was read. No new audit, plan, migration, production SQL, provider call, customer email, merge, deployment, Ready label or message to John. The final clean committed tree and changed-file boundary must be compared with the remote draft head before handoff.
