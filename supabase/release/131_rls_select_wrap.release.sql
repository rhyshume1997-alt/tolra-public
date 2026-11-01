-- 131_rls_select_wrap.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 131: every row-level-security policy asks its role and company helpers once per statement, not once per row (ChatGPT search
-- verdict 4b, option C; the follow-up named in 121's header). WORKING NUMBER: the final number is given at merge, and the file is then
-- generated again against the policies main has at that point. Touches no table, row, function, trigger, grant or setting: only the
-- USING / WITH CHECK text of 181 policies.
--
-- THE COST. A policy such as USING (organization_id = current_user_organization_id() AND has_org_role(ARRAY['admin', 'office']))
-- calls each helper for EVERY row a statement looks at. 121 made each call about 10x cheaper, but PostgreSQL still makes it once per
-- row: a function call in a policy is evaluated per row, a scalar sub-select that names no column of the row (an InitPlan) once per
-- statement. Measured on the local stand-in (two companies, each 20,000 quotes, invoices and jobs and 50,000 quote lines and 50,000
-- invoice lines; signed in as company A's admin, request.jwt.claims as PostgREST sets it; median of 3, EXPLAIN ANALYZE TIMING OFF):
--   search quotes (ref / customer / PO ilike) 1,290 -> 41 ms; search invoices 1,290 -> 23 ms; search jobs 990 -> 23 ms;
--   quote line text ilike 3,650 -> 54 ms; invoice line text ilike 3,260 -> 55 ms;
--   quotes list first 1,000 81 -> 1 ms, all 20,000 1,310 -> 18 ms; invoices 48 -> 1 / 1,000 -> 14 ms; jobs 47 -> 1 / 1,090 -> 17 ms.
--   Every result identical (md5 of the rows).
--
-- WHAT CHANGES. In 181 of the 216 policies on public, storage.objects and security_audit.audit_log, each call of a helper that
-- takes no argument or only constants is written (SELECT <call>): has_org_role(<roles>) 213 times, current_user_organization_id()
-- 199, auth.uid() 18, user_organization_id() 9 (439 calls). The meaning is the same:
--   * every one of these helpers is STABLE: within one statement it reads the statement's snapshot and the same request settings,
--     so it gives every row the same answer; none writes, and a call that fails fails at its first use, as before. The sub-select
--     returns exactly the call's value (one row, the same type; NULL stays NULL);
--   * the InitPlan runs only when the expression first needs it, so an AND / OR that never reached the call still never makes it;
--   * names, tables, commands, roles and PERMISSIVE / RESTRICTIVE are unchanged (ALTER POLICY ... USING / WITH CHECK only).
-- Calls that take a column of the row (admin_may_read_profile(id), admin_may_edit_profile(id), job_file_quote_reference_ok(...),
-- storage.foldername(name)) still run per row, as they must. The 54 calls main already writes as a sub-select (section_allowed,
-- session_read_only, session_is_active and four auth.uid()) are left as they are; the 35 policies with nothing to wrap are not touched.
-- PROOF (local): after 131, every policy's text with each "( SELECT call AS name)" put back to "call" is main's text exactly (all
-- 216); the catalogue changes only in those 181 policies' expression md5; the rollback gives main's catalogue back exactly.
--
-- GUARD (section 1): each policy 131 rewrites is there with main's command, roles and kind, and its text is main's (or already
-- 131's). Safe to run again. SELF-CHECK (section 3). Verify: supabase/verify/rls_select_wrap_131.sql (every row TRUE).
-- Rollback: supabase/release/131_rls_select_wrap.rollback.sql (main's policy text back; only with Rhys's approval).
-- =====================================================================================================

-- The policy text below names public tables and helpers without a schema, as PostgreSQL prints them; parse it (and print it for the
-- checks) with the search path the catalogue uses. Ends with this transaction.
SELECT pg_catalog.set_config('search_path', 'public, extensions', TRUE);

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: each policy 131 rewrites is main's (or already 131's): same command, roles and kind; text md5 as main's
--    catalogue (tests/db/catalogue.snapshot.json) or 131's.
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  WITH want(schema_name, table_name, policy_name, permissive, cmd, roles, md5_main, md5_131) AS (VALUES
    ('public', 'ai_helper_requests', 'ai_helper_requests office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_settings', 'ai_helper_settings office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_usage', 'ai_helper_usage office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'attendance_event_network_ips', 'attendance_event_network_ips rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_event_networks', 'attendance_event_networks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_events', 'attendance_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_exemptions', 'clock_in_network_exemptions rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_locks', 'clock_in_network_locks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'clock_in_network_unverified', 'clock_in_network_unverified rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'credit_notes', 'credit_notes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_notes', 'credit_notes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'credit_notes', 'credit_notes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_notes', 'credit_notes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'customer_credit_ledger', 'customer_credit_ledger rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'customers', 'customers rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'customers', 'customers rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'customers', 'customers rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'customers', 'customers rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '96c75c33346b7633b07d758e4aa6d383', 'afe7e599c68f3a70d966b2240f90b47d'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'delivery_notes', 'delivery_notes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'delivery_notes', 'delivery_notes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'delivery_notes', 'delivery_notes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '96c75c33346b7633b07d758e4aa6d383', 'afe7e599c68f3a70d966b2240f90b47d'),
    ('public', 'delivery_notes', 'delivery_notes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'document_attachments', 'document_attachments rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '65d5152bed9e043dcf180569b62f1fb2', 'd5e8c85d7a9726cd7b5fb2f83a18e838'),
    ('public', 'document_attachments', 'document_attachments rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eac2f05de167aaf5631117114800206c', 'f24a63c4d2c4f2655f27de42e6167460'),
    ('public', 'document_attachments', 'document_attachments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '65d5152bed9e043dcf180569b62f1fb2', 'd5e8c85d7a9726cd7b5fb2f83a18e838'),
    ('public', 'email_history', 'email_history rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'email_history', 'email_history rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd2ad9ec2e6b63d75c9c5996484b28ffb', '79b641dce3048126ea1d25c266b6e9a4'),
    ('public', 'email_history', 'email_history rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'email_history', 'email_history rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'email_schedule_runs', 'email_schedule_runs office select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'e92b788d951ce740d4157661bda75d07', 'ec3eaa346985c4d8b6f644dfdd8d29cb'),
    ('public', 'email_schedules', 'email_schedules admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'email_schedules', 'email_schedules admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'email_schedules', 'email_schedules admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5eb5430fefd11f45e3c5379a209e0b41', 'd1f0a8f12c537fb44e01f5375be08f23'),
    ('public', 'email_schedules', 'email_schedules member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'email_templates', 'email_templates member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'email_templates', 'email_templates office delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'email_templates', 'email_templates office insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'email_templates', 'email_templates office update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'import_batches', 'import_batches admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'import_mappings', 'import_mappings admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5eb5430fefd11f45e3c5379a209e0b41', 'd1f0a8f12c537fb44e01f5375be08f23'),
    ('public', 'import_record_keys', 'import_record_keys admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_runs', 'import_runs admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_stage', 'import_stage admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'inbound_emails', 'inbound_emails rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'inspector_authorisations', 'inspector_authorisations rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'integration_connections', 'integration_connections admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_contacts', 'integration_contacts admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_mappings', 'integration_mappings admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_sends', 'integration_sends admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'invoice_credit_allocations', 'invoice_credit_allocations rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'invoice_payments', 'invoice_payments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_queue_events', 'invoice_queue_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_reminder_sends', 'invoice_reminder_sends office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '95e4fec10d794513d1f5379683dc1be2', '312aac81449231bf38d2cc6b27c41cd8'),
    ('public', 'invoices', 'invoices rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoices', 'invoices rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'invoices', 'invoices rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoices', 'invoices rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'job_files', 'job_files customer po not for viewers', 'RESTRICTIVE', 'SELECT', '{authenticated}', '26ba84b14b5673be8a4838711aa13b83', '81711441216d8127226f4ca8e2c4ec8e'),
    ('public', 'job_files', 'job_files photos not for viewers', 'RESTRICTIVE', 'SELECT', '{authenticated}', '3f10ab2ecca0c26d229c5aacc7651361', '2bb860f9079915043c7f9a0bea300bfd'),
    ('public', 'job_files', 'job_files rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_files', 'job_files rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '46192704b51eb974752d0fbdfff0a519', '2ff9ab524eee153021051e94b787754d'),
    ('public', 'job_files', 'job_files rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_files', 'job_files rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'f26f9252aa50f5c3c1253b3a300917a7', '09b11d8fcd5e64675251fe3a88ede7f2'),
    ('public', 'job_flow_events', 'job_flow_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_inspections', 'job_inspections rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_machines', 'job_machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_part_logs', 'job_part_logs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_problems', 'job_problems rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework', 'job_rework rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework_entries', 'job_rework_entries rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework_entry_values', 'job_rework_entry_values rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_signoffs', 'job_signoffs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_values', 'job_values delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_values', 'job_values insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'job_values', 'job_values select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_values', 'job_values update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'jobs', 'jobs rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '43f05b0d9510d54d0eebc24bd8705346', '1981d4379619ef80ee61cf17f2f5bbc9'),
    ('public', 'jobs', 'jobs rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'jobs', 'jobs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'b8b9185154c36a316e4bb1f744ac0c3b', '47a967492d1b726bb739d47545efbf8d'),
    ('public', 'jobs', 'jobs rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'machine_bookings', 'machine_bookings tenant delete', 'PERMISSIVE', 'DELETE', '{public}', '1a18a7b1a61092fb504f2c73f7d0d4f1', '6f6227c1177bb709f1b526f1d37bf463'),
    ('public', 'machine_bookings', 'machine_bookings tenant insert', 'PERMISSIVE', 'INSERT', '{public}', 'e2cbbd263497effbf48aca82f6f613b9', 'd550605af7821e337f37b8c6f2f5a801'),
    ('public', 'machine_bookings', 'machine_bookings tenant select', 'PERMISSIVE', 'SELECT', '{public}', '70aac1d760f9d79e50fdd0fe1eca711d', '36e911bf69728c575f43d6a47a97e995'),
    ('public', 'machine_bookings', 'machine_bookings tenant update', 'PERMISSIVE', 'UPDATE', '{public}', 'f4651220c5242278f75c1cac605cb75d', 'dacc3cd60bd4e7e3342f55b57998b2d5'),
    ('public', 'machine_runs', 'machine_runs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'machines', 'machines rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'machines', 'machines rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'machines', 'machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'b8b9185154c36a316e4bb1f744ac0c3b', '47a967492d1b726bb739d47545efbf8d'),
    ('public', 'machines', 'machines rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'mail_poll_state', 'mail_poll_state rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'operator_sessions', 'operator_sessions rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'organization_invites', 'organization_invites admins read', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'organization_members', 'organization_members admins read org', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'organization_members', 'organization_members read own', 'PERMISSIVE', 'SELECT', '{authenticated}', '5eebdfba311617743b110b29a41f23a0', 'a7d7eb18352aa8797d6f9c34aa194875'),
    ('public', 'organization_settings', 'organization_settings insert', 'PERMISSIVE', 'INSERT', '{public}', '2df8e2cdcdfaa803fb80cf1d72806efb', '31217f1a286181dedb491fb3f1b0b8b6'),
    ('public', 'organization_settings', 'organization_settings select', 'PERMISSIVE', 'SELECT', '{public}', '70aac1d760f9d79e50fdd0fe1eca711d', '36e911bf69728c575f43d6a47a97e995'),
    ('public', 'organization_settings', 'organization_settings update', 'PERMISSIVE', 'UPDATE', '{public}', '1b3401f3412974a960a5e9ff71ac1876', '14fbf0f5f05d34ba3a83482ed7eb65b3'),
    ('public', 'organizations', 'organizations admin update own', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'c3809998874c31771767838463b180a1', 'e706ff804c1e275926bf481b9316d3e5'),
    ('public', 'organizations', 'organizations select own', 'PERMISSIVE', 'SELECT', '{authenticated}', '7505c6a588dbb6320309ac5d7128f35d', '99d8a76309f122a00dabbef46067b168'),
    ('public', 'overview_owed_snapshots', 'overview_owed_snapshots admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'purchase_orders', 'purchase_orders rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'purchase_orders', 'purchase_orders rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'purchase_orders', 'purchase_orders rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'purchase_orders', 'purchase_orders rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quote_attachments', 'quote_attachments rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_attachments', 'quote_attachments rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quote_attachments', 'quote_attachments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_attachments', 'quote_attachments rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quote_line_items', 'quote_line_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_line_items', 'quote_line_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quote_line_items', 'quote_line_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_line_items', 'quote_line_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quotes', 'quotes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quotes', 'quotes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quotes', 'quotes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quotes', 'quotes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'record_archive_state', 'record_archive_state select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'reopen_requests', 'reopen_requests member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'rfqs', 'rfqs rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'rfqs', 'rfqs rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'rfqs', 'rfqs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'rfqs', 'rfqs rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'sales_order_line_machines', 'sales_order_line_machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'sales_order_lines', 'sales_order_lines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'sales_orders', 'sales_orders rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'sales_orders', 'sales_orders rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'sales_orders', 'sales_orders rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'sales_orders', 'sales_orders rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'site_network_members', 'site_network_members rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'site_network_settings', 'site_network_settings rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'site_networks', 'site_networks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'stock', 'stock rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'stock', 'stock rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'stock', 'stock rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'stock', 'stock rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'suppliers', 'suppliers rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'suppliers', 'suppliers rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'suppliers', 'suppliers rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'suppliers', 'suppliers rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'time_day_flags', 'time_day_flags rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'time_settings', 'time_settings rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'eb4e88c6ee43647d519a025dd6a79dc6', '84db117edbfe90e8e8dac937305f6d4c'),
    ('public', 'time_sync_rejections', 'time_sync_rejections rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'time_week_approvals', 'time_week_approvals rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'timesheet_sends', 'timesheet_sends office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '1cbd867efcfe2dd1b1130687385ea3a6', '41df2ededed25cc3a22136d71ada5dd8'),
    ('public', 'user_profiles', 'Admins insert org profiles', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'user_profiles', 'Users read own profile', 'PERMISSIVE', 'SELECT', '{authenticated}', 'cc00666ac5d81806b4129769e28761f3', 'b3158818130bc2650ee2c7bd09b38a45'),
    ('public', 'user_profiles', 'Users update own profile', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'bce2f8985e0259798c9fce72dc059cb9', 'a7e6bac74873af04f399dcc47fc2e90e'),
    ('security_audit', 'audit_log', 'audit admins read org', 'PERMISSIVE', 'SELECT', '{public}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('storage', 'objects', 'document-attachments org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '48c068dc1f6f78db386a692d9c82e7d4', '109c41f4481d07b0cbfde076012a9961'),
    ('storage', 'objects', 'document-attachments org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd800791c699190fe37b4631839d33087', '1efb2a5fe88143699916ff3bf0fd9fb1'),
    ('storage', 'objects', 'document-attachments org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'f77c8da95cb3c654d26eebe9e6a81865', '2b937f5ff34db78626a3064877b1f70d'),
    ('storage', 'objects', 'job drawings org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd9e9fa22029f0234a16ec54c112bf9d3', '2b7ec566b4506d9dc5918f7b02dd8374'),
    ('storage', 'objects', 'job drawings org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'bbb84de21258884a22122095a319bcb6', '2c8b842a92e82cbe88c465be8de536b4'),
    ('storage', 'objects', 'job drawings org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd866ab0dfc3d21799b22a4177450667e', '0ecf1bddff5101df38f2fad021989797'),
    ('storage', 'objects', 'job drawings org update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '78f03b9d476b23cc8407cc0d9f7add8a', '76e489d7de7f079451629dc75177d894'),
    ('storage', 'objects', 'job photos: only the reserved object is uploaded', 'RESTRICTIVE', 'INSERT', '{authenticated}', '359160824b8c7ba48fc1474457d43979', '8203733db41b1d0e8ee251d634ba025b'),
    ('storage', 'objects', 'job photos: the reserved object is uploaded', 'PERMISSIVE', 'INSERT', '{authenticated}', '389ad203e85df9af80a3c678bcc9bc95', 'f18378ccdc69491c5575a8d36b06b577'),
    ('storage', 'objects', 'org-logos admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '8f4aa52a4d44db9be01ba7f39cb1481f', 'edb0c20b93f1657f1c28411f6626e296'),
    ('storage', 'objects', 'org-logos admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd40a9e57674c9fed460361c042aa247c', '4c6b17900a334b7fdfd64ba9e4614cfe'),
    ('storage', 'objects', 'org-logos admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'be1c7e4b6055e4952115b8dfc8de408a', '3fa3424546ce8004b672741752029d22'),
    ('storage', 'objects', 'org-logos org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'ede390297f9303f6a7a0e7127d9110b8', '0dc0025c633b06116fb54c4211617a80'),
    ('storage', 'objects', 'quote-attachments org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'ca0f9558e9fdbc73bcbefa14e41d4901', 'b0dc02e5ec9957c1ac5aab8520377d3c'),
    ('storage', 'objects', 'quote-attachments org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '5b4d08e645139b8d0e67da40c058d658', '46d89e29270cd400ca29d28c43e59d47'),
    ('storage', 'objects', 'quote-attachments org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'ca0f9558e9fdbc73bcbefa14e41d4901', 'b0dc02e5ec9957c1ac5aab8520377d3c'),
    ('storage', 'objects', 'quote-attachments org update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'e2a8ca60b496ed0b9cec2c9a418f13cf', 'bd77f2c32624450148c1c34c5ab5123e'),
    ('storage', 'objects', 'quote-attachments referenced by jobs', 'PERMISSIVE', 'SELECT', '{authenticated}', '52bb4c1d75c7687088aaab88e213de6f', '5c603dbf51c316313aa9d26ecf5b4eda')
  ),
  have AS (
    SELECT p.schemaname, p.tablename, p.policyname, p.permissive, p.cmd, p.roles::TEXT AS roles,
           md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) AS m
    FROM pg_catalog.pg_policies p
  )
  SELECT string_agg(w.schema_name || '.' || w.table_name || ' :: ' || w.policy_name
                    || CASE WHEN h.policyname IS NULL THEN ' (missing)' WHEN h.permissive <> w.permissive OR h.cmd <> w.cmd OR h.roles <> w.roles THEN ' (command, roles or kind differ)'
                            ELSE ' (text md5 ' || h.m || ')' END, '; ' ORDER BY 1)
  FROM want w LEFT JOIN have h ON h.schemaname = w.schema_name AND h.tablename = w.table_name AND h.policyname = w.policy_name
  WHERE h.policyname IS NULL OR h.permissive <> w.permissive OR h.cmd <> w.cmd OR h.roles <> w.roles OR h.m NOT IN (w.md5_main, w.md5_131)
  INTO v_bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '131: these policies are not main''s (nor 131''s); stop and compare: %', v_bad;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2a. The 162 public policies: each helper call that names no column of the row written (SELECT <call>). Generated
--     from main's own text (pg_policies), nothing else changed.
ALTER POLICY "ai_helper_requests office select" ON public.ai_helper_requests
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "ai_helper_settings office select" ON public.ai_helper_settings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "ai_helper_usage office select" ON public.ai_helper_usage
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "attendance_event_network_ips rbac select" ON public.attendance_event_network_ips
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "attendance_event_networks rbac select" ON public.attendance_event_networks
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "attendance_events rbac select" ON public.attendance_events
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "clock_in_network_exemptions rbac select" ON public.clock_in_network_exemptions
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "clock_in_network_locks rbac select" ON public.clock_in_network_locks
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "clock_in_network_unverified rbac select" ON public.clock_in_network_unverified
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "credit_note_lines rbac delete" ON public.credit_note_lines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_note_lines rbac insert" ON public.credit_note_lines
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_note_lines rbac select" ON public.credit_note_lines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_note_lines rbac update" ON public.credit_note_lines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_notes rbac delete" ON public.credit_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_notes rbac insert" ON public.credit_notes
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_notes rbac select" ON public.credit_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "credit_notes rbac update" ON public.credit_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "customer_credit_ledger rbac select" ON public.customer_credit_ledger
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "customers rbac delete" ON public.customers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "customers rbac insert" ON public.customers
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "customers rbac select" ON public.customers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "customers rbac update" ON public.customers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "delivery_note_items rbac delete" ON public.delivery_note_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "delivery_note_items rbac insert" ON public.delivery_note_items
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "delivery_note_items rbac select" ON public.delivery_note_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "delivery_note_items rbac update" ON public.delivery_note_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "delivery_notes rbac delete" ON public.delivery_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "delivery_notes rbac insert" ON public.delivery_notes
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "delivery_notes rbac select" ON public.delivery_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "delivery_notes rbac update" ON public.delivery_notes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "document_attachments rbac delete" ON public.document_attachments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((delivery_note_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR ((purchase_order_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed)))));
ALTER POLICY "document_attachments rbac insert" ON public.document_attachments
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (uploaded_by = (SELECT auth.uid())) AND (((delivery_note_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR ((purchase_order_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed)))));
ALTER POLICY "document_attachments rbac select" ON public.document_attachments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((delivery_note_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR ((purchase_order_id IS NOT NULL) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed)))));
ALTER POLICY "email_history rbac delete" ON public.email_history
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "email_history rbac insert" ON public.email_history
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[])) AND (drafted_by = (SELECT auth.uid()))));
ALTER POLICY "email_history rbac select" ON public.email_history
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "email_history rbac update" ON public.email_history
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "email_schedule_runs office select" ON public.email_schedule_runs
  USING (((EXISTS ( SELECT 1
   FROM email_schedules s
  WHERE ((s.id = email_schedule_runs.schedule_id) AND (s.organization_id = (SELECT current_user_organization_id()))))) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "email_schedules admin delete" ON public.email_schedules
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "email_schedules admin insert" ON public.email_schedules
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "email_schedules admin update" ON public.email_schedules
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "email_schedules member select" ON public.email_schedules
  USING ((organization_id = (SELECT current_user_organization_id())));
ALTER POLICY "email_templates member select" ON public.email_templates
  USING ((organization_id = (SELECT current_user_organization_id())));
ALTER POLICY "email_templates office delete" ON public.email_templates
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "email_templates office insert" ON public.email_templates
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "email_templates office update" ON public.email_templates
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "import_batches admin select" ON public.import_batches
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_mappings admin delete" ON public.import_mappings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_mappings admin insert" ON public.import_mappings
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_mappings admin select" ON public.import_mappings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_mappings admin update" ON public.import_mappings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_record_keys admin select" ON public.import_record_keys
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_runs admin select" ON public.import_runs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "import_stage admin select" ON public.import_stage
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "inbound_emails rbac select" ON public.inbound_emails
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "inspector_authorisations rbac select" ON public.inspector_authorisations
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "integration_connections admin select" ON public.integration_connections
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "integration_contacts admin select" ON public.integration_contacts
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "integration_mappings admin select" ON public.integration_mappings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "integration_sends admin select" ON public.integration_sends
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "invoice_credit_allocations rbac select" ON public.invoice_credit_allocations
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_line_items rbac delete" ON public.invoice_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_line_items rbac insert" ON public.invoice_line_items
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_line_items rbac select" ON public.invoice_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_line_items rbac update" ON public.invoice_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_payments rbac select" ON public.invoice_payments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_queue_events rbac select" ON public.invoice_queue_events
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoice_reminder_sends office select" ON public.invoice_reminder_sends
  USING (((EXISTS ( SELECT 1
   FROM email_schedules s
  WHERE ((s.id = invoice_reminder_sends.schedule_id) AND (s.organization_id = (SELECT current_user_organization_id()))))) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoices rbac delete" ON public.invoices
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoices rbac insert" ON public.invoices
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoices rbac select" ON public.invoices
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "invoices rbac update" ON public.invoices
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_files customer po not for viewers" ON public.job_files
  USING (((kind <> 'customer_po'::text) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job_files photos not for viewers" ON public.job_files
  USING (((kind <> 'photo'::text) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job_files rbac delete" ON public.job_files
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_files rbac insert" ON public.job_files
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job_files rbac select" ON public.job_files
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_files rbac update" ON public.job_files
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job_flow_events rbac select" ON public.job_flow_events
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_inspections rbac select" ON public.job_inspections
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_machines rbac select" ON public.job_machines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_part_logs rbac select" ON public.job_part_logs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_problems rbac select" ON public.job_problems
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_rework rbac select" ON public.job_rework
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_rework_entries rbac select" ON public.job_rework_entries
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_rework_entry_values rbac select" ON public.job_rework_entry_values
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_signoffs rbac select" ON public.job_signoffs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job_values delete" ON public.job_values
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_values insert" ON public.job_values
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_values select" ON public.job_values
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "job_values update" ON public.job_values
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "jobs rbac delete" ON public.jobs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin}'::text[]))));
ALTER POLICY "jobs rbac insert" ON public.jobs
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "jobs rbac select" ON public.jobs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop,viewer}'::text[]))));
ALTER POLICY "jobs rbac update" ON public.jobs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop}'::text[]))));
ALTER POLICY "machine_bookings tenant delete" ON public.machine_bookings
  USING (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "machine_bookings tenant insert" ON public.machine_bookings
  WITH CHECK (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "machine_bookings tenant select" ON public.machine_bookings
  USING ((organization_id = (SELECT user_organization_id())));
ALTER POLICY "machine_bookings tenant update" ON public.machine_bookings
  USING (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))))
  WITH CHECK (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "machine_runs rbac select" ON public.machine_runs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "machines rbac delete" ON public.machines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "machines rbac insert" ON public.machines
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "machines rbac select" ON public.machines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office,workshop,viewer}'::text[]))));
ALTER POLICY "machines rbac update" ON public.machines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "mail_poll_state rbac select" ON public.mail_poll_state
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "operator_sessions rbac select" ON public.operator_sessions
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "organization_invites admins read" ON public.organization_invites
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "organization_members admins read org" ON public.organization_members
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "organization_members read own" ON public.organization_members
  USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "organization_settings insert" ON public.organization_settings
  WITH CHECK (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "organization_settings select" ON public.organization_settings
  USING ((organization_id = (SELECT user_organization_id())));
ALTER POLICY "organization_settings update" ON public.organization_settings
  USING (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "organizations admin update own" ON public.organizations
  USING (((id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))))
  WITH CHECK ((id = (SELECT current_user_organization_id())));
ALTER POLICY "organizations select own" ON public.organizations
  USING ((id = (SELECT current_user_organization_id())));
ALTER POLICY "overview_owed_snapshots admin select" ON public.overview_owed_snapshots
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "purchase_orders rbac delete" ON public.purchase_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "purchase_orders rbac insert" ON public.purchase_orders
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "purchase_orders rbac select" ON public.purchase_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "purchase_orders rbac update" ON public.purchase_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_attachments rbac delete" ON public.quote_attachments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_attachments rbac insert" ON public.quote_attachments
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_attachments rbac select" ON public.quote_attachments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_attachments rbac update" ON public.quote_attachments
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_line_items rbac delete" ON public.quote_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_line_items rbac insert" ON public.quote_line_items
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_line_items rbac select" ON public.quote_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quote_line_items rbac update" ON public.quote_line_items
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quotes rbac delete" ON public.quotes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quotes rbac insert" ON public.quotes
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quotes rbac select" ON public.quotes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "quotes rbac update" ON public.quotes
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "record_archive_state select" ON public.record_archive_state
  USING ((organization_id = (SELECT current_user_organization_id())));
ALTER POLICY "reopen_requests member select" ON public.reopen_requests
  USING ((organization_id = (SELECT current_user_organization_id())));
ALTER POLICY "rfqs rbac delete" ON public.rfqs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "rfqs rbac insert" ON public.rfqs
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "rfqs rbac select" ON public.rfqs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "rfqs rbac update" ON public.rfqs
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "sales_order_line_machines rbac select" ON public.sales_order_line_machines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "sales_order_lines rbac select" ON public.sales_order_lines
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "sales_orders rbac delete" ON public.sales_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "sales_orders rbac insert" ON public.sales_orders
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "sales_orders rbac select" ON public.sales_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "sales_orders rbac update" ON public.sales_orders
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "site_network_members rbac select" ON public.site_network_members
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "site_network_settings rbac select" ON public.site_network_settings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "site_networks rbac select" ON public.site_networks
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "stock rbac delete" ON public.stock
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "stock rbac insert" ON public.stock
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "stock rbac select" ON public.stock
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "stock rbac update" ON public.stock
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "suppliers rbac delete" ON public.suppliers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "suppliers rbac insert" ON public.suppliers
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "suppliers rbac select" ON public.suppliers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "suppliers rbac update" ON public.suppliers
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))))
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role('{admin,office}'::text[]))));
ALTER POLICY "time_day_flags rbac select" ON public.time_day_flags
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "time_settings rbac select" ON public.time_settings
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "time_sync_rejections rbac select" ON public.time_sync_rejections
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "time_week_approvals rbac select" ON public.time_week_approvals
  USING (((organization_id = (SELECT current_user_organization_id())) AND (((user_id = (SELECT auth.uid())) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])))));
ALTER POLICY "timesheet_sends office select" ON public.timesheet_sends
  USING (((EXISTS ( SELECT 1
   FROM email_schedules s
  WHERE ((s.id = timesheet_sends.schedule_id) AND (s.organization_id = (SELECT current_user_organization_id()))))) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "Admins insert org profiles" ON public.user_profiles
  WITH CHECK (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "Users read own profile" ON public.user_profiles
  USING (((SELECT auth.uid()) = id));
ALTER POLICY "Users update own profile" ON public.user_profiles
  USING (((SELECT auth.uid()) = id))
  WITH CHECK (((SELECT auth.uid()) = id));

-- -----------------------------------------------------------------------------------------------------
-- 2b. The same for the 19 policies on security_audit.audit_log and storage.objects.
ALTER POLICY "audit admins read org" ON security_audit.audit_log
  USING (((organization_id = (SELECT current_user_organization_id())) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "document-attachments org delete" ON storage.objects
  USING (((bucket_id = 'document-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND ((((storage.foldername(name))[2] = 'delivery-notes'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (((storage.foldername(name))[2] = 'purchase-orders'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed))) AND (NOT (EXISTS ( SELECT 1
   FROM document_attachments a
  WHERE (a.storage_path = objects.name))))));
ALTER POLICY "document-attachments org insert" ON storage.objects
  WITH CHECK (((bucket_id = 'document-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND ((((storage.foldername(name))[2] = 'delivery-notes'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text])) AND (EXISTS ( SELECT 1
   FROM delivery_notes d
  WHERE (((d.id)::text = (storage.foldername(objects.name))[3]) AND (d.organization_id = (SELECT current_user_organization_id())))))) OR (((storage.foldername(name))[2] = 'purchase-orders'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed) AND (EXISTS ( SELECT 1
   FROM purchase_orders p
  WHERE (((p.id)::text = (storage.foldername(objects.name))[3]) AND (p.organization_id = (SELECT current_user_organization_id())))))))));
ALTER POLICY "document-attachments org select" ON storage.objects
  USING (((bucket_id = 'document-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND ((((storage.foldername(name))[2] = 'delivery-notes'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))) OR (((storage.foldername(name))[2] = 'purchase-orders'::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text])) AND ( SELECT section_allowed('purchase-orders'::text) AS section_allowed)))));
ALTER POLICY "job drawings org delete" ON storage.objects
  USING (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job drawings org insert" ON storage.objects
  WITH CHECK (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job drawings org select" ON storage.objects
  USING (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "job drawings org update" ON storage.objects
  USING (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))))
  WITH CHECK (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));
ALTER POLICY "job photos: only the reserved object is uploaded" ON storage.objects
  WITH CHECK (((bucket_id <> 'job-photos'::text) OR (EXISTS ( SELECT 1
   FROM job_files f
  WHERE ((f.storage_bucket = 'job-photos'::text) AND (f.storage_path = objects.name) AND (f.kind = 'photo'::text) AND (f.upload_state = 'reserved'::text) AND (f.deleted_at IS NULL) AND (f.created_by = (SELECT auth.uid())) AND (f.organization_id = (SELECT current_user_organization_id())))))));
ALTER POLICY "job photos: the reserved object is uploaded" ON storage.objects
  WITH CHECK (((bucket_id = 'job-photos'::text) AND (EXISTS ( SELECT 1
   FROM job_files f
  WHERE ((f.storage_bucket = 'job-photos'::text) AND (f.storage_path = objects.name) AND (f.kind = 'photo'::text) AND (f.upload_state = 'reserved'::text) AND (f.deleted_at IS NULL) AND (f.created_by = (SELECT auth.uid())) AND (f.organization_id = (SELECT current_user_organization_id())))))));
ALTER POLICY "org-logos admin delete" ON storage.objects
  USING (((bucket_id = 'org-logos'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "org-logos admin insert" ON storage.objects
  WITH CHECK (((bucket_id = 'org-logos'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "org-logos admin update" ON storage.objects
  USING (((bucket_id = 'org-logos'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text]))))
  WITH CHECK (((bucket_id = 'org-logos'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text]))));
ALTER POLICY "org-logos org select" ON storage.objects
  USING (((bucket_id = 'org-logos'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text]))));
ALTER POLICY "quote-attachments org delete" ON storage.objects
  USING (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "quote-attachments org insert" ON storage.objects
  WITH CHECK (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "quote-attachments org select" ON storage.objects
  USING (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "quote-attachments org update" ON storage.objects
  USING (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))))
  WITH CHECK (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text]))));
ALTER POLICY "quote-attachments referenced by jobs" ON storage.objects
  USING (((bucket_id = 'quote-attachments'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text, 'viewer'::text])) AND (EXISTS ( SELECT 1
   FROM job_files f
  WHERE ((f.organization_id = (SELECT current_user_organization_id())) AND (f.storage_bucket = 'quote-attachments'::text) AND (f.storage_path = objects.name))))));

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: every policy is 131's (same command, roles, kind; 131's text), and no policy on these tables still
--    calls one of the helpers outside a sub-select.
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  WITH want(schema_name, table_name, policy_name, permissive, cmd, roles, md5_main, md5_131) AS (VALUES
    ('public', 'ai_helper_requests', 'ai_helper_requests office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_settings', 'ai_helper_settings office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_usage', 'ai_helper_usage office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'attendance_event_network_ips', 'attendance_event_network_ips rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_event_networks', 'attendance_event_networks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_events', 'attendance_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_exemptions', 'clock_in_network_exemptions rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_locks', 'clock_in_network_locks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'clock_in_network_unverified', 'clock_in_network_unverified rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_note_lines', 'credit_note_lines rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'credit_notes', 'credit_notes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_notes', 'credit_notes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'credit_notes', 'credit_notes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'credit_notes', 'credit_notes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'customer_credit_ledger', 'customer_credit_ledger rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'customers', 'customers rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'customers', 'customers rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'customers', 'customers rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'customers', 'customers rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '96c75c33346b7633b07d758e4aa6d383', 'afe7e599c68f3a70d966b2240f90b47d'),
    ('public', 'delivery_note_items', 'delivery_note_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'delivery_notes', 'delivery_notes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'delivery_notes', 'delivery_notes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'delivery_notes', 'delivery_notes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '96c75c33346b7633b07d758e4aa6d383', 'afe7e599c68f3a70d966b2240f90b47d'),
    ('public', 'delivery_notes', 'delivery_notes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'document_attachments', 'document_attachments rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '65d5152bed9e043dcf180569b62f1fb2', 'd5e8c85d7a9726cd7b5fb2f83a18e838'),
    ('public', 'document_attachments', 'document_attachments rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eac2f05de167aaf5631117114800206c', 'f24a63c4d2c4f2655f27de42e6167460'),
    ('public', 'document_attachments', 'document_attachments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '65d5152bed9e043dcf180569b62f1fb2', 'd5e8c85d7a9726cd7b5fb2f83a18e838'),
    ('public', 'email_history', 'email_history rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'email_history', 'email_history rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd2ad9ec2e6b63d75c9c5996484b28ffb', '79b641dce3048126ea1d25c266b6e9a4'),
    ('public', 'email_history', 'email_history rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'email_history', 'email_history rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'email_schedule_runs', 'email_schedule_runs office select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'e92b788d951ce740d4157661bda75d07', 'ec3eaa346985c4d8b6f644dfdd8d29cb'),
    ('public', 'email_schedules', 'email_schedules admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'email_schedules', 'email_schedules admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'email_schedules', 'email_schedules admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5eb5430fefd11f45e3c5379a209e0b41', 'd1f0a8f12c537fb44e01f5375be08f23'),
    ('public', 'email_schedules', 'email_schedules member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'email_templates', 'email_templates member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'email_templates', 'email_templates office delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'email_templates', 'email_templates office insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'email_templates', 'email_templates office update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'import_batches', 'import_batches admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'import_mappings', 'import_mappings admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_mappings', 'import_mappings admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5eb5430fefd11f45e3c5379a209e0b41', 'd1f0a8f12c537fb44e01f5375be08f23'),
    ('public', 'import_record_keys', 'import_record_keys admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_runs', 'import_runs admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'import_stage', 'import_stage admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'inbound_emails', 'inbound_emails rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'inspector_authorisations', 'inspector_authorisations rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'integration_connections', 'integration_connections admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_contacts', 'integration_contacts admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_mappings', 'integration_mappings admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'integration_sends', 'integration_sends admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'invoice_credit_allocations', 'invoice_credit_allocations rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_line_items', 'invoice_line_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'invoice_payments', 'invoice_payments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_queue_events', 'invoice_queue_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoice_reminder_sends', 'invoice_reminder_sends office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '95e4fec10d794513d1f5379683dc1be2', '312aac81449231bf38d2cc6b27c41cd8'),
    ('public', 'invoices', 'invoices rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoices', 'invoices rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'invoices', 'invoices rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'invoices', 'invoices rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'job_files', 'job_files customer po not for viewers', 'RESTRICTIVE', 'SELECT', '{authenticated}', '26ba84b14b5673be8a4838711aa13b83', '81711441216d8127226f4ca8e2c4ec8e'),
    ('public', 'job_files', 'job_files photos not for viewers', 'RESTRICTIVE', 'SELECT', '{authenticated}', '3f10ab2ecca0c26d229c5aacc7651361', '2bb860f9079915043c7f9a0bea300bfd'),
    ('public', 'job_files', 'job_files rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_files', 'job_files rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '46192704b51eb974752d0fbdfff0a519', '2ff9ab524eee153021051e94b787754d'),
    ('public', 'job_files', 'job_files rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_files', 'job_files rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'f26f9252aa50f5c3c1253b3a300917a7', '09b11d8fcd5e64675251fe3a88ede7f2'),
    ('public', 'job_flow_events', 'job_flow_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_inspections', 'job_inspections rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_machines', 'job_machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_part_logs', 'job_part_logs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_problems', 'job_problems rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework', 'job_rework rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework_entries', 'job_rework_entries rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_rework_entry_values', 'job_rework_entry_values rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_signoffs', 'job_signoffs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'job_values', 'job_values delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_values', 'job_values insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'job_values', 'job_values select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'job_values', 'job_values update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'jobs', 'jobs rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '43f05b0d9510d54d0eebc24bd8705346', '1981d4379619ef80ee61cf17f2f5bbc9'),
    ('public', 'jobs', 'jobs rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7783492e65b781cfe89209df73819304', '01e4264ca6aa7544994058ff2d5bc12b'),
    ('public', 'jobs', 'jobs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'b8b9185154c36a316e4bb1f744ac0c3b', '47a967492d1b726bb739d47545efbf8d'),
    ('public', 'jobs', 'jobs rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '1ec4ea4d6b3abfc0e81977da40ab2097', 'a8f9ab62defea1d7f44727e3940f842b'),
    ('public', 'machine_bookings', 'machine_bookings tenant delete', 'PERMISSIVE', 'DELETE', '{public}', '1a18a7b1a61092fb504f2c73f7d0d4f1', '6f6227c1177bb709f1b526f1d37bf463'),
    ('public', 'machine_bookings', 'machine_bookings tenant insert', 'PERMISSIVE', 'INSERT', '{public}', 'e2cbbd263497effbf48aca82f6f613b9', 'd550605af7821e337f37b8c6f2f5a801'),
    ('public', 'machine_bookings', 'machine_bookings tenant select', 'PERMISSIVE', 'SELECT', '{public}', '70aac1d760f9d79e50fdd0fe1eca711d', '36e911bf69728c575f43d6a47a97e995'),
    ('public', 'machine_bookings', 'machine_bookings tenant update', 'PERMISSIVE', 'UPDATE', '{public}', 'f4651220c5242278f75c1cac605cb75d', 'dacc3cd60bd4e7e3342f55b57998b2d5'),
    ('public', 'machine_runs', 'machine_runs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'machines', 'machines rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'machines', 'machines rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'machines', 'machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'b8b9185154c36a316e4bb1f744ac0c3b', '47a967492d1b726bb739d47545efbf8d'),
    ('public', 'machines', 'machines rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'mail_poll_state', 'mail_poll_state rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'operator_sessions', 'operator_sessions rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'organization_invites', 'organization_invites admins read', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'organization_members', 'organization_members admins read org', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'organization_members', 'organization_members read own', 'PERMISSIVE', 'SELECT', '{authenticated}', '5eebdfba311617743b110b29a41f23a0', 'a7d7eb18352aa8797d6f9c34aa194875'),
    ('public', 'organization_settings', 'organization_settings insert', 'PERMISSIVE', 'INSERT', '{public}', '2df8e2cdcdfaa803fb80cf1d72806efb', '31217f1a286181dedb491fb3f1b0b8b6'),
    ('public', 'organization_settings', 'organization_settings select', 'PERMISSIVE', 'SELECT', '{public}', '70aac1d760f9d79e50fdd0fe1eca711d', '36e911bf69728c575f43d6a47a97e995'),
    ('public', 'organization_settings', 'organization_settings update', 'PERMISSIVE', 'UPDATE', '{public}', '1b3401f3412974a960a5e9ff71ac1876', '14fbf0f5f05d34ba3a83482ed7eb65b3'),
    ('public', 'organizations', 'organizations admin update own', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'c3809998874c31771767838463b180a1', 'e706ff804c1e275926bf481b9316d3e5'),
    ('public', 'organizations', 'organizations select own', 'PERMISSIVE', 'SELECT', '{authenticated}', '7505c6a588dbb6320309ac5d7128f35d', '99d8a76309f122a00dabbef46067b168'),
    ('public', 'overview_owed_snapshots', 'overview_owed_snapshots admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'purchase_orders', 'purchase_orders rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'purchase_orders', 'purchase_orders rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'purchase_orders', 'purchase_orders rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'purchase_orders', 'purchase_orders rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quote_attachments', 'quote_attachments rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_attachments', 'quote_attachments rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quote_attachments', 'quote_attachments rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_attachments', 'quote_attachments rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quote_line_items', 'quote_line_items rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_line_items', 'quote_line_items rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quote_line_items', 'quote_line_items rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quote_line_items', 'quote_line_items rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'quotes', 'quotes rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quotes', 'quotes rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'quotes', 'quotes rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'quotes', 'quotes rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'record_archive_state', 'record_archive_state select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'reopen_requests', 'reopen_requests member select', 'PERMISSIVE', 'SELECT', '{authenticated}', '001421a6576c1b6fbbb808a89ecbf391', 'aba327892564ca66f25161fdcaa8da48'),
    ('public', 'rfqs', 'rfqs rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'rfqs', 'rfqs rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'rfqs', 'rfqs rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'rfqs', 'rfqs rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'sales_order_line_machines', 'sales_order_line_machines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '5ad2d119d86695511a91edbc970881fa', 'b51fdb9c013bb763aa7141df53f37f70'),
    ('public', 'sales_order_lines', 'sales_order_lines rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'sales_orders', 'sales_orders rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('public', 'sales_orders', 'sales_orders rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '1119fdfbe777371eb5ac8c8fc827906e', '1a35fb1b2012d619accab921244582b3'),
    ('public', 'sales_orders', 'sales_orders rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'sales_orders', 'sales_orders rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '5cd04fff55dc985c7634b03ff43e08b3', '369c9e3cb9b8da8035af82e319a6aa3b'),
    ('public', 'site_network_members', 'site_network_members rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'site_network_settings', 'site_network_settings rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'site_networks', 'site_networks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'stock', 'stock rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'stock', 'stock rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'stock', 'stock rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'stock', 'stock rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'suppliers', 'suppliers rbac delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'suppliers', 'suppliers rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '7b5e35d2cb03e67cf8c15da3923b8ef7', 'b95a8d526b8c292397da7c12c8a25e72'),
    ('public', 'suppliers', 'suppliers rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'c957dab9715f3b7e43e39ded1e984ef0', '90036cbc57d00743c6f0f7bd0738a13a'),
    ('public', 'suppliers', 'suppliers rbac update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '61d4765d2dcf519419687f753b937da8', 'f070f4c172c8572cd2517a59cbb00801'),
    ('public', 'time_day_flags', 'time_day_flags rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'time_settings', 'time_settings rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'eb4e88c6ee43647d519a025dd6a79dc6', '84db117edbfe90e8e8dac937305f6d4c'),
    ('public', 'time_sync_rejections', 'time_sync_rejections rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'time_week_approvals', 'time_week_approvals rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'timesheet_sends', 'timesheet_sends office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '1cbd867efcfe2dd1b1130687385ea3a6', '41df2ededed25cc3a22136d71ada5dd8'),
    ('public', 'user_profiles', 'Admins insert org profiles', 'PERMISSIVE', 'INSERT', '{authenticated}', 'eb88838f77cc54ce415d0f1211b649f9', '8d519372ad4f1388990a4ad10cfeb5de'),
    ('public', 'user_profiles', 'Users read own profile', 'PERMISSIVE', 'SELECT', '{authenticated}', 'cc00666ac5d81806b4129769e28761f3', 'b3158818130bc2650ee2c7bd09b38a45'),
    ('public', 'user_profiles', 'Users update own profile', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'bce2f8985e0259798c9fce72dc059cb9', 'a7e6bac74873af04f399dcc47fc2e90e'),
    ('security_audit', 'audit_log', 'audit admins read org', 'PERMISSIVE', 'SELECT', '{public}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
    ('storage', 'objects', 'document-attachments org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '48c068dc1f6f78db386a692d9c82e7d4', '109c41f4481d07b0cbfde076012a9961'),
    ('storage', 'objects', 'document-attachments org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd800791c699190fe37b4631839d33087', '1efb2a5fe88143699916ff3bf0fd9fb1'),
    ('storage', 'objects', 'document-attachments org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'f77c8da95cb3c654d26eebe9e6a81865', '2b937f5ff34db78626a3064877b1f70d'),
    ('storage', 'objects', 'job drawings org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'd9e9fa22029f0234a16ec54c112bf9d3', '2b7ec566b4506d9dc5918f7b02dd8374'),
    ('storage', 'objects', 'job drawings org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'bbb84de21258884a22122095a319bcb6', '2c8b842a92e82cbe88c465be8de536b4'),
    ('storage', 'objects', 'job drawings org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd866ab0dfc3d21799b22a4177450667e', '0ecf1bddff5101df38f2fad021989797'),
    ('storage', 'objects', 'job drawings org update', 'PERMISSIVE', 'UPDATE', '{authenticated}', '78f03b9d476b23cc8407cc0d9f7add8a', '76e489d7de7f079451629dc75177d894'),
    ('storage', 'objects', 'job photos: only the reserved object is uploaded', 'RESTRICTIVE', 'INSERT', '{authenticated}', '359160824b8c7ba48fc1474457d43979', '8203733db41b1d0e8ee251d634ba025b'),
    ('storage', 'objects', 'job photos: the reserved object is uploaded', 'PERMISSIVE', 'INSERT', '{authenticated}', '389ad203e85df9af80a3c678bcc9bc95', 'f18378ccdc69491c5575a8d36b06b577'),
    ('storage', 'objects', 'org-logos admin delete', 'PERMISSIVE', 'DELETE', '{authenticated}', '8f4aa52a4d44db9be01ba7f39cb1481f', 'edb0c20b93f1657f1c28411f6626e296'),
    ('storage', 'objects', 'org-logos admin insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd40a9e57674c9fed460361c042aa247c', '4c6b17900a334b7fdfd64ba9e4614cfe'),
    ('storage', 'objects', 'org-logos admin update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'be1c7e4b6055e4952115b8dfc8de408a', '3fa3424546ce8004b672741752029d22'),
    ('storage', 'objects', 'org-logos org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'ede390297f9303f6a7a0e7127d9110b8', '0dc0025c633b06116fb54c4211617a80'),
    ('storage', 'objects', 'quote-attachments org delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'ca0f9558e9fdbc73bcbefa14e41d4901', 'b0dc02e5ec9957c1ac5aab8520377d3c'),
    ('storage', 'objects', 'quote-attachments org insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '5b4d08e645139b8d0e67da40c058d658', '46d89e29270cd400ca29d28c43e59d47'),
    ('storage', 'objects', 'quote-attachments org select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'ca0f9558e9fdbc73bcbefa14e41d4901', 'b0dc02e5ec9957c1ac5aab8520377d3c'),
    ('storage', 'objects', 'quote-attachments org update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'e2a8ca60b496ed0b9cec2c9a418f13cf', 'bd77f2c32624450148c1c34c5ab5123e'),
    ('storage', 'objects', 'quote-attachments referenced by jobs', 'PERMISSIVE', 'SELECT', '{authenticated}', '52bb4c1d75c7687088aaab88e213de6f', '5c603dbf51c316313aa9d26ecf5b4eda')
  ),
  have AS (
    SELECT p.schemaname, p.tablename, p.policyname, p.permissive, p.cmd, p.roles::TEXT AS roles,
           md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) AS m
    FROM pg_catalog.pg_policies p
  )
  SELECT string_agg(w.schema_name || '.' || w.table_name || ' :: ' || w.policy_name, '; ' ORDER BY 1)
  FROM want w LEFT JOIN have h ON h.schemaname = w.schema_name AND h.tablename = w.table_name AND h.policyname = w.policy_name
  WHERE h.policyname IS NULL OR h.permissive <> w.permissive OR h.cmd <> w.cmd OR h.roles <> w.roles OR h.m <> w.md5_131
  INTO v_bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '131: not 131''s after the rewrite: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policies p
           WHERE (p.schemaname = 'public' OR (p.schemaname, p.tablename) IN (('storage', 'objects'), ('security_audit', 'audit_log')))
             AND regexp_replace(coalesce(p.qual, '') || ' | ' || coalesce(p.with_check, ''), '\( SELECT (auth\.)?[a-z_]+\([^()]*\) AS [a-z_]+\)', '', 'g')
                 ~ '(^|[^a-z_.])(has_org_role|section_allowed|current_user_organization_id|user_organization_id|current_user_role|current_user_secondary_role|session_read_only|session_is_active)\(|auth\.(uid|jwt|role)\(') <> 0 THEN
    RAISE EXCEPTION '131: a policy still calls a role or company helper once per row (not inside a sub-select)';
  END IF;
END
$$;

COMMIT;
