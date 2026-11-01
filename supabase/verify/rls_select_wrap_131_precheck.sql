-- 131 PRECHECK (read only: one SELECT, writes nothing, changes no setting). Run on production BEFORE pasting
-- supabase/release/131_rls_select_wrap.release.sql, and paste only if every row's ok is TRUE. It prints, for each of the 182 policies 131
-- rewrites, the text md5 131's guard expects (main's, or 131's if already applied) next to the live one, so a PG17 difference in how
-- policy text is printed shows here and not as a refused paste. Rows: 1 to 5 summary, then one row per policy (n >= 10).
-- The md5 is of pg_policies' USING and WITH CHECK text, exactly as the guard takes it; it does not depend on the search path while public is
-- on it (row 2). Expected before the paste: row 3 says "182 main, 0 131, 0 other" and every row TRUE. After the paste: "0 main, 182 131".
-- Row 5 is public.legacy_audit_log's one policy, which supabase/import/import_legacy_tenant.sql made (no migration does): "main" (the
-- import script's text) before the paste and "131 already" after it on a project that ran the legacy import (production), "no table" elsewhere.
WITH want(schema_name, table_name, policy_name, permissive, cmd, roles, md5_main, md5_131) AS (VALUES
    ('public', 'ai_helper_requests', 'ai_helper_requests office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_settings', 'ai_helper_settings office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'ai_helper_usage', 'ai_helper_usage office select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'attendance_event_network_ips', 'attendance_event_network_ips rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_event_networks', 'attendance_event_networks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'attendance_events', 'attendance_events rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_exemptions', 'clock_in_network_exemptions rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'a7039586719a5eb88e387f127cc9034b', '14f218c24e3af08658a68116b0748f1f'),
    ('public', 'clock_in_network_locks', 'clock_in_network_locks rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
    ('public', 'clock_in_network_refusals', 'clock_in_network_refusals admin select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94'),
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
    ('public', 'email_history', 'email_history rbac insert', 'PERMISSIVE', 'INSERT', '{authenticated}', 'd2ad9ec2e6b63d75c9c5996484b28ffb', '49213200206620f1b40d3eddeaecfab3'),
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
    ('public', 'site_network_names', 'site_network_names rbac select', 'PERMISSIVE', 'SELECT', '{authenticated}', '55ca9a2d4469b23ea4d522e94be4f1a9', '6a18e9fed9ee8dd956c314df2b296562'),
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
),
cmp AS (
  SELECT w.*, h.m AS live_md5,
         CASE WHEN h.policyname IS NULL THEN 'MISSING'
              WHEN h.permissive <> w.permissive OR h.cmd <> w.cmd OR h.roles <> w.roles
                THEN 'COMMAND, ROLES OR KIND DIFFER (live ' || h.permissive || ' ' || h.cmd || ' ' || h.roles || ')'
              WHEN h.m = w.md5_main THEN 'main'
              WHEN h.m = w.md5_131 THEN '131 already'
              ELSE 'TEXT DIFFERS' END AS state
  FROM want w
  LEFT JOIN have h ON h.schemaname = w.schema_name AND h.tablename = w.table_name AND h.policyname = w.policy_name
),
-- public.legacy_audit_log's one policy (row 5), where the legacy import made the table: 131 rewrites it too (and its guard takes only these two).
leg AS (
  SELECT h.m,
         CASE WHEN to_regclass('public.legacy_audit_log') IS NULL THEN 'no table (no legacy import here)'
              WHEN h.policyname IS NULL THEN 'MISSING'
              WHEN h.permissive <> 'PERMISSIVE' OR h.cmd <> 'SELECT' OR h.roles <> '{authenticated}'
                THEN 'COMMAND, ROLES OR KIND DIFFER (live ' || h.permissive || ' ' || h.cmd || ' ' || h.roles || ')'
              WHEN h.m = 'd52d07dfca8db97c66ed1573ebd3a6c1' THEN 'main'
              WHEN h.m = '0c3f9197b8141c8b66f15268b935ae94' THEN '131 already'
              ELSE 'TEXT DIFFERS' END AS state
  FROM (SELECT 1) AS one
  LEFT JOIN have h ON h.schemaname = 'public' AND h.tablename = 'legacy_audit_log' AND h.policyname = 'legacy_audit_log admins read'
),
-- Policies outside 131's list and row 5 that call a role or company helper outside a sub-select: 131's self-check would refuse them (0 expected).
per_row AS (
  SELECT p.schemaname || '.' || p.tablename || ' :: ' || p.policyname AS k
  FROM pg_catalog.pg_policies p
  WHERE (p.schemaname = 'public' OR (p.schemaname, p.tablename) IN (('storage', 'objects'), ('security_audit', 'audit_log')))
    AND (p.schemaname, p.tablename, p.policyname) NOT IN (('public', 'user_profiles', 'Users update own profile'), ('public', 'email_history', 'email_history rbac insert'))
    AND NOT EXISTS (SELECT 1 FROM want w WHERE w.schema_name = p.schemaname AND w.table_name = p.tablename AND w.policy_name = p.policyname)
    AND (p.schemaname, p.tablename, p.policyname) <> ('public', 'legacy_audit_log', 'legacy_audit_log admins read')
    AND regexp_replace(coalesce(p.qual, '') || ' | ' || coalesce(p.with_check, ''), '\( SELECT (auth\.)?[a-z_]+\([^()]*\) AS [a-z_]+\)', '', 'g')
        ~ '(^|[^a-z_.])(has_org_role|section_allowed|current_user_organization_id|user_organization_id|current_user_role|current_user_secondary_role|session_read_only|session_is_active)\(|auth\.(uid|jwt|role)\('
)
SELECT 1 AS n, 'postgres version' AS item, '17.x on production' AS expected_main, NULL::TEXT AS expected_131, current_setting('server_version') AS live,
       NULL::TEXT AS state, current_setting('server_version_num')::INT / 10000 IN (16, 17) AS ok
UNION ALL SELECT 2, 'public on the search path (md5s do not depend on the rest)', NULL, NULL, current_setting('search_path'), NULL,
       'public' = ANY (current_schemas(FALSE))
UNION ALL SELECT 3, 'the 182 policies 131 rewrites', '182', NULL,
       (SELECT count(*) FILTER (WHERE state = 'main') || ' main, ' || count(*) FILTER (WHERE state = '131 already') || ' 131, '
               || count(*) FILTER (WHERE state NOT IN ('main', '131 already')) || ' other' FROM cmp), NULL,
       (SELECT count(*) = 182 AND bool_and(state IN ('main', '131 already')) FROM cmp)
UNION ALL SELECT 4, 'other policies calling a helper once per row', '0', NULL, (SELECT count(*)::TEXT FROM per_row),
       (SELECT string_agg(k, '; ' ORDER BY k) FROM per_row), NOT EXISTS (SELECT 1 FROM per_row)
UNION ALL SELECT 5, 'public.legacy_audit_log :: legacy_audit_log admins read (made by the legacy import script, not a migration)',
       'd52d07dfca8db97c66ed1573ebd3a6c1', '0c3f9197b8141c8b66f15268b935ae94', (SELECT m FROM leg), (SELECT state FROM leg),
       (SELECT state IN ('no table (no legacy import here)', 'main', '131 already') FROM leg)
UNION ALL SELECT * FROM (
  SELECT (10 + row_number() OVER (ORDER BY schema_name, table_name, policy_name))::INT, schema_name || '.' || table_name || ' :: ' || policy_name,
         md5_main, md5_131, live_md5, state, state IN ('main', '131 already')
  FROM cmp) x
ORDER BY 1;
