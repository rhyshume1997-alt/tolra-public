# p171 rehearsal record (scratch database only)

Project: zjibfowsuvudlizafgbs (tolra-scratch-07nov). Never production. Run 26 Nov 2026 about 11:10 to 11:25 UTC through the Supabase MCP `execute_sql`.
Synthetic data: companies `ZZ ISO EDIT A` (00000000-0000-4000-8000-000000000101) and `ZZ ISO EDIT B` (...0102); users admin A (...0111), office A (...0112),
workshop A (...0113), viewer A (...0114), admin B (...0121), all `zz-iso-*@example.invalid`. Sessions were simulated with `SET LOCAL ROLE authenticated|anon`
and `request.jwt.claims` (sub, role, aal), inside transactions that were rolled back (so the table stayed empty between runs).

Pre-state: 120 tables in public, none of the p171 objects. The helpers p171 relies on (current_user_organization_id, has_org_role, my_session, assert_privileged_aal) exist.

## Steps and results
1. Applied `p171_iso_editable_documents.sql` (BEGIN..COMMIT): table, 1 policy, 1 trigger, 4 functions present, 121 tables.
2. Positive and negative matrix (every row below came out as shown; "REFUSED code" = the statement raised that SQLSTATE):

| Case | Result |
|---|---|
| P1 admin A saves quality-policy | OK version 1, draft |
| P2 save with p_base_version=1 | OK version 2 |
| P3 restore of v1 as a new version (p_restored_from=1, base 2) | OK version 3 (new row, v1 untouched) |
| P4 admin A approves v2 | OK status approved, approver "ZZ Admin A", approved_at set |
| P5 admin A reads own rows | 3 rows, 1 approved |
| P6/P7 admin B saves for B | OK; B has its own version 1 (numbers are per company) |
| N1 admin B reads | only B's 1 row, 0 of A's |
| N2 admin B approves A's quality-policy v2 | REFUSED P0002 Version not found (the function only ever looks in B) |
| N3-N5 office, workshop, viewer of A save | REFUSED 42501 Not permitted |
| N6 office A approves | REFUSED 42501 Not permitted |
| N7-N9 office, workshop, viewer read | 0 rows (RLS) |
| N10, N11 anon save / approve | REFUSED 42501 permission denied for function |
| N12 anon read | REFUSED 42501 permission denied for table |
| N13-N16 admin A direct INSERT / UPDATE / DELETE / approve-by-UPDATE | REFUSED 42501 permission denied for table (no grant) |
| N17 owner (postgres) UPDATE of an approved version's text | REFUSED 42501 hint append_only (trigger) |
| N18 owner re-opens an approved version to draft | REFUSED 42501 hint append_only (trigger) |
| N19 approve an already approved version | REFUSED 55000 hint already_approved |
| N20 approve version 99 | REFUSED P0002 |
| N21 blank approver name | REFUSED 22023 |
| N22 duplicate (company, doc, version) | REFUSED 23505 iso_document_versions_unique_version |
| N23 stale base_version (latest 3, sent 1) | REFUSED 40001 hint stale_version |
| N24 unknown doc id; N25 body without sections; N26 section text 20001 chars; N27 note 501 chars; N28 restore of unknown version | REFUSED 22023 each |
| N29 admin calls the internal guard function directly | REFUSED 42501 permission denied for function |
| N30 company requires admin 2FA, admin token aal1 saves | REFUSED 42501 "Confirm your authenticator code first" (mfa_required) |
| P8 same company, token aal2 | OK |
| P9 audit | 3 `iso_document.save` rows and 1 `iso_document.approve` row in security_audit.audit_log; new_data keys are only doc_id, version, status, text_length; the document text does not appear (checked: no match for a phrase from the body) |

N30/P8 ran with the organizations user triggers disabled inside a rolled-back transaction, because the production guard refuses to switch the 2FA requirement on while an admin has no authenticator; the change was rolled back.
Not exercised: a platform-owner support session (support / read-only branch of iso_document_caller); it is the same two-line check as save_chase_steps_atomic (163).

3. Rollback with a committed row present: one row saved (records-index v1, committed). `p171_iso_editable_documents.rollback.sql` REFUSED, changing nothing:
   `p171 rollback: 1 ISO document version(s) exist; ... this file never deletes records, so nothing was changed`.
4. Removed the rehearsal row as owner (DELETE is allowed to non-browser roles only), ran the rollback: table null, 0 functions, 0 policies, 120 tables in public (same as the pre-state).
5. Ran the rollback again on the clean database: no error, nothing to do (idempotent).
6. Re-applied the proposal: table, 1 policy, 1 trigger, 4 functions, 121 tables (clean re-apply).
7. Rolled back again to leave the scratch database as it was found: 120 tables, none of the objects. Synthetic users, profiles and memberships deleted.

## Left behind on scratch (cannot be removed)
The two companies `ZZ ISO EDIT A` / `ZZ ISO EDIT B` remain, because security_audit.audit_log is append-only and holds rows that reference them (audit_log_organization_id_fkey). They have no members and no data. The audit rows from this rehearsal (iso_document.save / approve, plus member/profile change rows) also remain, as designed.
