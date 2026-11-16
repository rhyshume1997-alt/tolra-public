# Independent review follow-up — jobs 24 to 29

Updated 3 November 2026. Draft PRs only; no Ready labels, merges, SQL applications or deployments. Other builders’ branches were not changed.

| Job | Draft PR | Work done | Checks |
|---|---|---|---|
| 24 | [#153](https://github.com/rhyshume1997-alt/tolra-public/pull/153) | One company-scoped settings RPC; approval must match saved reviewed text; atomic send claim rejects stale text, concurrent edits and second approvals. | 34 focused cases reported passing; TypeScript/lint and exact latest web passed. |
| 25 | [#154](https://github.com/rhyshume1997-alt/tolra-public/pull/154) | Real proposal SQL tests, new-container-only Postgres runner and non-destructive RPC rollback. Two companies, role refusal, reused IDs, simultaneous saves and forced late rollback. | Syntax/whitespace and web passed. SQL NOT RUN. Portable authentication/table fixture is not full production session/MFA/audit proof. |
| 26 | [#155](https://github.com/rhyshume1997-alt/tolra-public/pull/155) | Own branch off costing-wiring: one atomic request, null/zero/explicit machine labour preserved, fractional pennies refused. | 22 focused cases reported passing; TypeScript/lint and latest web passed. |
| 27 | [#156](https://github.com/rhyshume1997-alt/tolra-public/pull/156) | Own branch off paid-claim-adapter: actual mailbox, strict sender validation, case, exact domain and plus-address checks. | 55 focused cases reported passing; TypeScript/lint and latest web passed. |
| 28a | [#157](https://github.com/rhyshume1997-alt/tolra-public/pull/157) | One reconciled detector/adapter, all original detector/adapter/UK/sender tests unchanged, plus end-to-end cases. | 139 focused cases reported passing; TypeScript/lint and latest web passed. |
| 28b | [#158](https://github.com/rhyshume1997-alt/tolra-public/pull/158) | One reconciled bank parser/matcher retaining original quote, six-bank-format and later matching safeguards and assertions. | 73 focused cases reported passing; TypeScript/lint and latest web passed. |
| 29 | This PR | [Merge guide](MERGE-ORDER.md) now includes 48 PR verdicts, supplied independent NOT SAFE results, new fix PRs and canonical integration order. Ownership and handover updated. | Verdict coverage, supplied verdict preservation, PR links and whitespace checked. |

Local Vitest still reports file results then needs timeout cleanup; these counts are reported test-case results, not claims of a clean local process exit. Remote web CI is separate evidence. No full local suite was run for this queue.

## Current exact-head web evidence

| PR | Head | Result at check | Evidence |
|---|---|---|---|
| #158 | 63abc9c1a648c8969289bc696b7907a097e9e138 | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41579229222/job/125730340757) |
| #157 | 04598b451b019a986414e5bc92d596a5257c67fd | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578950642/job/125729476982) |
| #156 | a13ff77ee1d85840f9bb37c87f5aae676a26a84a | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578694180/job/125728653857) |
| #155 | b6000d944b882656950610e7dcdfc79f5ef9c9f7 | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578410671/job/125727713699) |
| #154 | e996332ee4f0f51d223e08c8277406f5c6b3f1e6 | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41578114989/job/125726773320) |
| #153 | 5d6b2540f82c50fccc1789dfac9799a851a1a172 | success | [web](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41577754413/job/125725640111) |

## Still blocked

- SQL execution is deliberately unrun: Rhys said not to apply anything anywhere. Claude must review/package the new company-scoped chase signature and costing RPC, run the throwaway tests and full integrated Supabase permission/concurrency checks, then manage any database application.
- The atomic/Postgres runner uses a fresh container and small contract fixture; it does not test the real session, MFA, audit triggers or complete base-schema RLS. A green web job does not execute these SQL cases.
- #155 inherits the same costing/main preflight conflict identified earlier. Its base owner/Claude must retain main security markers 136/137 and costing 143 when integrating. Do not ship #123 without its atomic fix.
- Live browser, mail-provider/send-result and payment checks remain. An unknown chase-send result stays claimed for checking; no automatic retry/edit is allowed.
- Durable customer IDs, bank parent-page callback connection and bank transaction identity across exports remain integration work. A valid sender string is not email authentication.
- Another owner closed #141 without merging; its 25 extra timesheet cases need preserving/porting to the updated stack. #119–121 merged only into feature bases. #114/#122 merged to main by others.
- JNR must fill named support contacts and numbers before go-live.

The three supplied independent NOT SAFE verdicts (#117/#123/#132) are retained. Other SAFE/SAFE WITH CONDITIONS/NOT SAFE decisions are clearly identified as builder 2 assessments, not fabricated reviewer results.

DONE for this follow-up queue, with the holds above.

Final CI check: all six code PRs #153–158 have PASS web results on the exact heads above. The first #159 documentation head took the intentional docs-only web skip. SQL tests remain NOT RUN; web CI does not execute them.
