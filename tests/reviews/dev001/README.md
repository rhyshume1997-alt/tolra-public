# DEV-001 — Staff hold alert: failing tests first

**No application implementation.** Run `npx vitest run -c tests/reviews/dev001/vitest.config.ts`. This is a deliberately red contract for Code to pick up. No SQL/database/provider call is made; all refused responses are synthetic. Main and the go-live branch are unchanged.

Proposed DLN wording: “Delivery notes are paused while the next number is checked. Ask the office for help. Your note has not been saved.” Proposed whole-company wording: “Work for this company is paused. Ask your supervisor or the office before trying again. Your changes have not been saved.” Do not tell staff to keep retrying, edit a counter, lift the hold or assume work was saved.

The real release-147 signal is code 55000 / hint `dln_numbering_not_set`. `company_on_hold` is a **proposed typed whole-company signal**, not a claim that the server already emits it. Code must decide and verify its authenticated source and clear/reset rules. An ordinary permission/network failure must not be labelled a hold. Never expose another company's name, IDs or raw database details. Keep entered work, accessible `role=alert`, no success toast/navigation, no background resend or repeated mutation.

The fixture component/helper are byte-for-byte public `9d7725e` copies, solely to exercise the existing form on a main-based test branch. No new UI is implemented and no candidate file is edited. The tested `lib/friendly-error.ts` is unchanged between main and that public commit. A failed assertion exercises a real generic-message result, not a missing module. This only contracts the inline alert; a persistent staff-wide company banner, navigation, permissions, expiry/reload, offline display and full server/UI wiring still need Code's implementation and tests.

Source component SHA-256: `1a4e32ba690cff557df4d4d5d876f41439061b09c34fccde5b1ef6b3f19dc25a`. Preserve failing logs and expectations. Do not approve/merge this as a working feature. Requirement DEV-001; expected plain hold alert and preserved work; actual ____ NOT EXECUTED for feature acceptance; evidence ____; tester ____; date ____; approval ____.

Committed run `42878a7`, 5 November 2026 UTC: **2 passed, 4 failed, zero skipped; exit 1**, as intended for the missing alert. Source lint and TypeScript passed. Original failing logs are retained unchanged with their hash. The failures demonstrate actual generic wording, not fixture/import/setup failure. This evidence commit implements nothing.
