# p172 rehearsal record (scratch database only)

Project: zjibfowsuvudlizafgbs (scratch). Never production. Run 26 Nov 2026 about 19:10 to 19:25 UTC through the Supabase MCP `execute_sql` (5 calls).
Synthetic data: companies `ZZ PRICE A` (00000000-0000-4000-8000-000000000301) and `ZZ PRICE B` (...0302); users John, admin X, office, workshop, viewer, an
inactive admin (all company A, ...0311 to ...0316) and an admin of B (...0321), all `zz-price-*@example.invalid`. Sessions were simulated with `SET LOCAL ROLE
authenticated|anon` and `request.jwt.claims` (sub, role, aal) inside one transaction; the figures are made-up examples.

Pre-state: 120 tables in public, none of the p172 objects; helpers (current_user_organization_id, has_org_role, my_session, assert_privileged_aal) present.

## Steps and results
1. Applied `p172_pricing_costing_settings.sql` (BEGIN..COMMIT): 1 table, 1 policy, 4 functions, 121 tables.
2. Matrix (every row came out as shown; REFUSED code = the statement raised that SQLSTATE):

| Case | Result |
|---|---|
| N00 nobody designated: John (an admin) reads / saves | 0 rows / REFUSED 42501 |
| P01 admin overview with nobody designated | OK, viewer null, candidates = active admins |
| N01-N04 office, workshop, viewer designate; office overview | REFUSED 42501 |
| N05-N07 anon designate, save, read table | REFUSED 42501 (no grant) |
| N08 admin of company B designates John | REFUSED 22023 (not an admin of B) |
| N09-N11 designate an office user, an inactive admin, an unknown id | REFUSED 22023 each |
| N12 internal guard called directly | REFUSED 42501 permission denied for function |
| P02 admin X designates John | OK |
| P03 same person again | OK changed=false (no-op) |
| P04-P06 John reads own row, saves, reads figures back (version 9 later) | OK, figures round trip |
| N20-N27 other admin X, office, workshop, viewer, admin of B: read | 0 rows each; save REFUSED 42501 |
| N28-N31 direct INSERT / UPDATE / DELETE by John, UPDATE by admin X | REFUSED 42501 permission denied (no grant) |
| N40 stale base version | REFUSED 40001 hint stale_version |
| N41-N49 unknown key, string figure, 2.5 men, period weekly, negative amount, blank name, non-object | REFUSED 22023 each |
| N46, N47 hours 169, profit percent 101 | REFUSED 23514 (table check) |
| P08, P09 John saves all-empty, then figures again | OK |
| N50 company requires admin 2FA, token aal1 | REFUSED 42501 hint mfa_required |
| P10 same company, token aal2 | OK |
| P11 audit | 4 `pricing_costs.save` rows and 1 `pricing_costs.viewer_set` row |
| P12 audit rows containing a figure or a cost name | 0 |
| P13 admin X designates himself (John to X) | OK figures_cleared=true |
| P14 X reads | the row, with NO figures (all null, running costs []), version bumped |
| N51, N52 John after losing designation: read / save | 0 rows / REFUSED 42501 |
| P15, N53 X clears the designation; X reads | OK; 0 rows (nobody sees) |
| N54 a second row for the same company (owner) | REFUSED 23505 (one designation per company by primary key) |

Notes: N50/P10 set `require_admin_mfa` with `session_replication_role = replica` (the production guard refuses to switch the requirement on while an admin has no authenticator) and
switched it back to false in the same run (checked: false). P06 first ran with a typo in the test query (not the SQL under test) and was re-run: John reads `2 | 40.00 | 50.00 | 10.00 | 100000.00 | 25.00 | [one example rent] | v9`.
Not exercised: a platform-owner support session (it is refused by the same `my_session` support/read_only check used by p171 and 163).

3. Rollback with figures present: `p172_pricing_costing_settings.rollback.sql` REFUSED, changing nothing (`p172 rollback: costing figures exist; ...`).
4. Figures removed as owner (designation row left), rollback ran: 0 tables, 0 functions, 120 tables in public (the pre-state).
5. Rollback again on the clean database: no error, nothing to do.
6. Re-apply: LIMITATION, to save approvals the re-apply after the rollback was an abbreviated copy (table, policy, caller guard and overview function; 121 tables, 1 policy), not the full file;
   the full file text was applied and proven in step 1. Then rolled back again, and the synthetic users, profiles and memberships deleted: final state 0 / 0 / 120 tables / 0 members / 0 users.

## Left behind on scratch (cannot be removed)
The two companies `ZZ PRICE A` / `ZZ PRICE B` remain, because security_audit.audit_log is append-only and holds rows that reference them. They have no members and no data. The audit rows
from this rehearsal also remain, as designed.
