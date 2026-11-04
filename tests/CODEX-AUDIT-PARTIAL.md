# CI audit stopped by Rhys

Stopped on 4 November 2026 at the budget priority change. 52 of 61 frozen heads completed unit/typecheck checks; remaining heads and the final CI head are NOT TESTED. Exact partial counts and full SHAs are in CODEX-AUDIT-PARTIAL.json. No completion or release approval is claimed.

All 61 explicit app/components/lib ESLint runs completed: 0 errors, 3 warnings each. Local Node24.22.1/npm11.9, not a Node22 CI result. Matching locked dependencies were used.

Findings:

- codex/161-reviewed-text 7f30174b6e6e763c90eaef5681c36f50dc7ee783: 5013 collected assertions pass but command exits1; missing locked jsdom prevents chase-reviewed-text.test.ts collection. Unchanged diagnostic reproduced one unhandled error.
- codex/costing-sql-test-plan 6431e60284a4591ab6c9552de5bc0dd0468973f3: 5357 units pass; tsc fails TS2559 at tests/support/costing-proposal-setup.ts:20, ProcessEnv incompatible with Environment.
- codex/costing-preflight-main: 472 skips, 60 golden examples plus412 rounding cases, because the engine is absent.
- codex/plain-english-main and codex/plain-english-privacy: 412 rounding skips each; optional exported pyRound guard. No skip acceptance recorded.

CI follow-up retains all existing tests and now has100 focused gate tests passing: actual zero command exits/error accounting, explicit Operations Pack and five wipe DB proof groups, all18 CW checks. The final whole suite was deliberately NOT repeated. npm lint now names app/components/lib rather than its old no-op invocation. Validation table placement/columns and current baseline notes are corrected; signatures stay blank.

No held branch repaired, no SQL or real data touched. Backend image-store ENOSPC, missing authoritative Operations Pack, actual backup/restore, ordered SQL, private combined wipe/import, browser runtime and Rhys validation remain BLOCKED/NOT TESTED. Full audit is unfinished, not SAFE.
