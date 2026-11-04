# CR: builder 4 cross-review, 4 November 2026

Reviewed PRs #290–#297 against their actual 34 changed files and immediate source dependencies. This is a source/document review, not release approval or a new broad audit. Builder 4's branches and docs/signoff/ remain untouched. Corrections are proposed only in this builder-3 draft based on #289.

| PR | Exact reviewed head | Source finding / limit |
| --- | --- | --- |
| #290 | `d9bcbc398b283e621ea4d73bcf90ef18f7ccc1b9` | Contact blanks, incident stop rules, uncertain-send handling and paper reconciliation are explicit. No additional source mistake found; private contacts/rehearsal remain NOT RUN. |
| #291 | `01067cab327ddc7107a99a015522530d736519c8` | Current guide reflects admin-only corrections for another person and actual Start/End break button labels. No additional source mistake found; printing/training remain NOT RUN. |
| #292 | `55ee54c3b64d812745731a7090c42b483571f7c0` | Current paper recovery gives other-person time correction to an admin, holds unclear matches and avoids replaying queued work. No additional source mistake found; actual recovery rehearsal remains NOT RUN. |
| #293 | `0cfe4495a805d0c41acbdbe7a5f8b892006df68a` | 146 rollback/refusal/history and backup state distinctions agree with the release SQL. No reapply workaround added; actual restore/recovery proof remains NOT RUN. |
| #294 | `ac49a303512288e76c95f74522ec3abdaf251f34` | Fixed nonexistent lib/integrations/accounting reference to actual lib/accounting/cloud-adapters.ts. That file enforces /api/accounting/<provider>/callback; no DNS/provider setting changed. |
| #295 | `865058f4a3e9dfa1afdefb51d3d6b72d401cda29` | Microsoft then configured Resend then draft selection agrees with send-company-email.ts; uncertain delivery is held before manual fallback. No additional source mistake found; real mailbox receipt remains NOT RUN. |
| #296 | `b35e5caf003fba6c6f25082bcfae311ae35e5fd4` | Corrected the cap paragraph: used plus reserved is not a reliable off switch, since settlement/refund can release reserved headroom. Directs to the existing company AI off switch. Other reviewed changes are literal user-visible strings; no permissions/maths/send behaviour changed. |
| #297 | `b9406d136f224395a4e6f2d15f82093f1ba2f545` | Read reverse SQL binding swap and actual-helper tests against original proof/helper sources. Historic alpha/beta captions are acknowledged; real bindings swap. Logs show 164 + 43 offline passes and two missing-backend failures, not DB/CSRF/build proof. No additional source mistake found. |

## Exact changes in this PR

1. `tests/C10-TOLRA-DOMAIN-SWITCH-CHECKLIST.md`: carries the reviewed builder-4 checklist with its single bad provider source path corrected. Preserve/ integrate this corrected version instead of overwriting it with the earlier #294 text.
2. `components/platform/tolra-ai-caps.tsx`: carries builder 4's plain wording for held money, corrects its stop instruction and preserves all existing code/limits. A request may settle for less than reserved, releasing capacity; lowering a cap to current used+reserved can therefore permit later requests. The existing AI off control is the stop mechanism. No new feature or calculation.
3. This report records all eight source heads, findings and limits. No builder-4 handover or sign-off paper was rewritten.

Checks: `npx eslint components/platform/tolra-ai-caps.tsx` exits 0. `npx vitest run tests/unit/tolra-ai-caps-ui.test.ts tests/unit/tolra-ai-caps.test.ts`: 11 passed, zero failures/skips. Literal-copy/document corrections use existing relevant tests; no redundant new test was added. Full lint/typecheck/unit integration is job CV, not claimed here.

The working source used shared preinstalled dependencies and a reconstructed #289 candidate. This is not a clean-install or exact-head CI/runtime result. No SQL, DNS/provider action, live email, main merge, deployment or Ready label. Source findings apply to the exact heads above; refresh review if they move. Operator/training/restore/domain/mail/security runtime evidence remains open.
