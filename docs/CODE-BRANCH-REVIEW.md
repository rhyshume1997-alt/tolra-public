# Claude branch review — job 34

Reviewed exact heads on 3 November 2026. Scope: changed app/server/pure parser/store/timing code, money arithmetic, company/role boundaries, email recipients/send approval and screen wording. This is not a database/provider sign-off.

| Branch/head | Confirmed finding | Own code-only fix / checks |
|---|---|---|
| claude/chase-steps / 12dce0957b411131449cd1d22feb3cb111d075f9 | First same-name customer mailbox could be guessed; ambiguous drafts could be approved; custom total omitted credits from face total. | #180; 3 identity regressions failed first; 46 focused cases reported passing afterwards, tsc/lint pass. Preserve #172 reviewed-text claim too. |
| claude/sliq-import / 6cf644e6e78f4fa9310288b9827588de619e8f87 | Quantity/percentage parsers returned unsafe integers or Infinity. | #181; 5 failures first; 98 focused cases reported passing, tsc/syntax/lint pass. No importer execution. |
| claude/e13-timesheet-days / 8eefa3eb1a346b68cf48afdd8f44fc1bb3dead75 | No additional confirmed fault in the reviewed chosen-day/form/store paths. Exact #141 test file already copied into this base. | Keep 25 extra cases and verify real DB/provider/DST delivery; not a production approval. |
| claude/costing-in-app / 8c4c7fe056119b1d9cff6bb70be96d751cbe3f5d | Base integer-pence/percentage validators, scoped writes, null/zero labour and RLS reviewed; no new confirmed store defect. Its integration had 412 optional Python cases skipped. Enabling them exposed 2 large-value rounding failures in the TS port. | #182 after #174: exact-decimal conversion once; signed zero; no optional rounding skip; 490 focused cases reported passing, tsc/lint pass. |

GitHub lookup of open and closed PRs with each exact Claude head returned no PR. Direct source-PR comments are therefore blocked; no source PR number is invented. Findings are posted on [coordination #178](https://github.com/rhyshume1997-alt/tolra-public/pull/178#issuecomment-6596526718), [chase #180](https://github.com/rhyshume1997-alt/tolra-public/pull/180#issuecomment-6596527851), [SliQ #181](https://github.com/rhyshume1997-alt/tolra-public/pull/181#issuecomment-6596528973) and [rounding #182](https://github.com/rhyshume1997-alt/tolra-public/pull/182#issuecomment-6596608894). The later rounding finding is also on #178 (6596607728).

Other builders’ branches were not changed. No tests were weakened, no migration/SQL/import was run, no Ready label was added and no PR was merged or deployed. Local focused Vitest still needs timeout cleanup after file results; exact-head web CI is separate evidence. Verify the final joined code and full-schema permissions before production.

Follow-up #182 full CI: Test Files  372 passed (372); Tests  5489 passed (5489); no optional rounding skips. Exact head/tree evidence is in VITEST-HEAD-EVIDENCE.md.
