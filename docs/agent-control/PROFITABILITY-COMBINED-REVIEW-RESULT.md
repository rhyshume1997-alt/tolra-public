# #378 + #412 reviewer check — not approval to activate

Owner: Codex verification. Claude Code integrates; ChatGPT reviews; Rhys owns release decisions. John/company approval of labour, machine and overhead rates and inclusion flags is still missing. #412 remains NOT SAFE to activate under the reviewer verdict. No new costing feature, rate or screen is added here. This branch starts at main68f89ca and combines our #378f5de19a with #412795ae4a for tests only.

The hash-pinned public original calculator atccd74ea is evaluated as a test oracle, using unchanged supplier/invoice helpers. Both original penny errors are reproduced in the same tests that check the combined code:

| Case | Original observed result | Combined result |
| --- | --- | --- |
| 91 huge synthetic invoices less one allocated purchase and5500p production costs | 8999999999994409p rather than exact8999999999994410p | Refuses the unsafe revenue aggregate; actual profit and projected completion profit are null. It does not return a rounded unsafe number. |
| 360 separate sessions of3600.000500 seconds at10000p/hour | 3600000p | 3600001p, nearest penny halves up; projected recorded cost uses the same3600001p. |

Focused validation:112 passed,0 failed,0 skipped (existing actual/projection/rework/UI/supplier/overview tests plus9 combined-review cases). TypeScript and targeted lint pass. Missing labour/machine rates, recorded hours, supplier reads and approval each block completion cost/profit/margin. OFF wins even with valid data. Existing original failure logs remain under tests/reviews/profitability-fix/evidence/before.log; the new oracle source and hash make reproduction repeatable, without production code duplication.

The existing disposable148 test also checks database default OFF, admin/MFA/financial permissions, company isolation, unchanged legacy source records, rollback and re-release. It creates its own labelled isolated container and nonce database, checks identity before every SQL write, and records commit/time/SQL hash/exit/log hash. It initially refused because its old equality assertion expected an unwrapped release file, while #378 now correctly generates a transaction wrapper. The test now compares the release to releaseSql(migration, filename) exactly and executes that release. No security assertion was removed; original failed log retained. This minimal synthetic prerequisite test is not full Supabase/auth/browser or147+148 integration proof.

CODED / TESTED only. No production database/rates/flag changed; no real data/provider calls. Local remaining-work projection inputs are not saved. No missing cost becomes zero. MERGED / DEPLOYED / LIVE VERIFIED and final candidate acceptance remain UNPROVEN. The passed tests do not overturn #412's NOT SAFE activation verdict. Code must integrate/review an exact SHA; no self-merge.
