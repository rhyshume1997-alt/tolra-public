\set ON_ERROR_STOP off
SET timezone='UTC';
\i repo_wipe.sql
CREATE TABLE IF NOT EXISTS testfx.reports(lbl text, rep jsonb);
-- keep the dry-run report text (DETAIL) for the record
DO $d$ DECLARE d text; BEGIN
  BEGIN PERFORM pg_temp.tolra_wipe($j${"confirm":"WIPE OPERATIONAL DATA","dry_run":true,"counters":"reset","counter_prefixes":["QUO","J","INV","SO","PO","CRD"],"allow_audit_row_delete":true,
 "wipe_orgs":["264fe031-5381-4d70-a8fd-113c1713bc65","2a213c03-c440-450d-9217-e2bbfcaff6b5"],
 "delete_org":"75b27c0c-2e85-486e-b1f4-4e9b9c045ca7",
 "delete_org_audit_ids":["133a7654-e02a-430f-9bbf-a46fa2ab23de","a1c3f71b-2729-4fb5-99f9-79bfb7f5d5f1"],
 "delete_users":[{"id":"6d084998-baad-49d3-b3aa-cad95a26560d","email":"rhumecoaching@gmail.com"},{"id":"dc05fa61-1b18-4892-9abf-43ae651535d8","email":"test@test.com"},{"id":"ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7","email":"test@testmail.com"}],
 "keep_admins":["cabd4289-e7dd-448e-9fed-a7cfab216cda","8703c781-adff-43f5-a258-dc1eb49c2d13"],
 "expected":{"264fe031-5381-4d70-a8fd-113c1713bc65":{"customers":9,"suppliers":9,"quotes":28,"jobs":27,"sales_orders":21,"purchase_orders":10,"delivery_notes":10,"invoices":20,"machines":1,"stock":6},
             "2a213c03-c440-450d-9217-e2bbfcaff6b5":{"customers":1,"quotes":3,"jobs":2,"sales_orders":1,"invoices":1}}}$j$::jsonb);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; INSERT INTO testfx.reports VALUES ('dry:'||SQLERRM, d::jsonb); END;
END $d$;
\echo === TEST 2: REAL run (dry_run:false) inside an explicit transaction, then ROLLBACK
BEGIN;
CREATE TEMP TABLE _rep AS SELECT pg_temp.tolra_wipe($j${"confirm":"WIPE OPERATIONAL DATA","dry_run":false,"counters":"reset","counter_prefixes":["QUO","J","INV","SO","PO","CRD"],"allow_audit_row_delete":true,
 "wipe_orgs":["264fe031-5381-4d70-a8fd-113c1713bc65","2a213c03-c440-450d-9217-e2bbfcaff6b5"],
 "delete_org":"75b27c0c-2e85-486e-b1f4-4e9b9c045ca7",
 "delete_org_audit_ids":["133a7654-e02a-430f-9bbf-a46fa2ab23de","a1c3f71b-2729-4fb5-99f9-79bfb7f5d5f1"],
 "delete_users":[{"id":"6d084998-baad-49d3-b3aa-cad95a26560d","email":"rhumecoaching@gmail.com"},{"id":"dc05fa61-1b18-4892-9abf-43ae651535d8","email":"test@test.com"},{"id":"ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7","email":"test@testmail.com"}],
 "keep_admins":["cabd4289-e7dd-448e-9fed-a7cfab216cda","8703c781-adff-43f5-a258-dc1eb49c2d13"],
 "expected":{"264fe031-5381-4d70-a8fd-113c1713bc65":{"customers":9,"suppliers":9,"quotes":28,"jobs":27,"sales_orders":21,"purchase_orders":10,"delivery_notes":10,"invoices":20,"machines":1,"stock":6},
             "2a213c03-c440-450d-9217-e2bbfcaff6b5":{"customers":1,"quotes":3,"jobs":2,"sales_orders":1,"invoices":1}}}$j$::jsonb) AS rep;
SELECT 'real_run_returned' k, rep->>'dry_run' dry_run, jsonb_array_length(rep->'users_deleted') users_deleted, rep->'counter_prefixes_reset' prefixes, rep->'counters_previous' counters_previous, rep->>'existing_audit_rows_verified_by_id_hash_digest' audit_rows_verified, rep->'triggers_disabled_then_restored' IS NOT NULL has_trigger_list FROM _rep;
\echo --- inside the transaction: the 60 wipe tables, both companies
WITH w(t) AS (SELECT jsonb_object_keys((SELECT rep->'reconciliation'->'after_all_zero'->'264fe031-5381-4d70-a8fd-113c1713bc65' FROM _rep)))
SELECT count(*) AS wipe_tables_reported, (SELECT count(*) FROM _rep, jsonb_each(rep->'reconciliation'->'after_all_zero'->'264fe031-5381-4d70-a8fd-113c1713bc65') e WHERE e.value::text <> '0') AS jnr_nonzero, (SELECT count(*) FROM _rep, jsonb_each(rep->'reconciliation'->'after_all_zero'->'2a213c03-c440-450d-9217-e2bbfcaff6b5') e WHERE e.value::text <> '0') AS marpet_nonzero FROM w;
SELECT 'inside: orgs' k, count(*) FROM public.organizations;
SELECT 'inside: DATA_WIPE rows' k, count(*) FROM security_audit.audit_log WHERE action='DATA_WIPE';
SELECT 'inside: DATA_WIPE metadata' k, organization_id, metadata->'counters_previous' cp FROM security_audit.audit_log WHERE action='DATA_WIPE' ORDER BY 2;
SELECT 'inside: auth test users left' k, count(*) FROM auth.users WHERE id IN ('6d084998-baad-49d3-b3aa-cad95a26560d','dc05fa61-1b18-4892-9abf-43ae651535d8','ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7');
SELECT 'inside: counters' k, organization_id, prefix, last FROM public.doc_counters WHERE organization_id IN ('264fe031-5381-4d70-a8fd-113c1713bc65','2a213c03-c440-450d-9217-e2bbfcaff6b5') ORDER BY 2,3;
SELECT 'inside: wipe table rows remaining for the two companies' k, sum(c) FROM (SELECT (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) c FROM public.%I WHERE organization_id IN (''264fe031-5381-4d70-a8fd-113c1713bc65'',''2a213c03-c440-450d-9217-e2bbfcaff6b5'')', t.table_name), false, true, '')))[1]::text::bigint c FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND t.table_name IN (SELECT jsonb_object_keys(rep->'reconciliation'->'after_all_zero'->'264fe031-5381-4d70-a8fd-113c1713bc65') FROM _rep)) z;
SELECT 'inside: enabled/disabled triggers' k, count(*) FILTER (WHERE tgenabled='D') disabled FROM pg_trigger WHERE NOT tgisinternal;
SELECT 'inside: tables that differ from before' k, count(*) FROM testfx.fp() f JOIN testfx.snap s ON s.tbl=f.tbl WHERE s.h IS DISTINCT FROM f.h;
ROLLBACK;
\echo === after ROLLBACK
SELECT f.tbl, s.n AS n_before, f.n AS n_after FROM testfx.fp() f JOIN testfx.snap s ON s.tbl=f.tbl WHERE s.h IS DISTINCT FROM f.h OR s.n<>f.n;
SELECT 'tables_equal_after_rollback' k, count(*) FROM testfx.fp() f JOIN testfx.snap s ON s.tbl=f.tbl WHERE s.h=f.h AND s.n=f.n;
SELECT 'DATA_WIPE rows after rollback' k, count(*) FROM security_audit.audit_log WHERE action='DATA_WIPE';
SELECT 'disabled triggers after rollback' k, count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D';
