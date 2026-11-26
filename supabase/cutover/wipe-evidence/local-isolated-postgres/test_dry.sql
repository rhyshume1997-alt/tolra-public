\set ON_ERROR_STOP off
SET timezone='UTC';
\i repo_wipe.sql
SELECT md5(prosrc) body_md5, length(prosrc) len FROM pg_proc WHERE proname='tolra_wipe' AND pronamespace=pg_my_temp_schema();
\echo === TEST 1: direct dry_run:true call, plain statement
SELECT pg_temp.tolra_wipe($j${"confirm":"WIPE OPERATIONAL DATA","dry_run":true,"counters":"reset","counter_prefixes":["QUO","J","INV","SO","PO","CRD"],"allow_audit_row_delete":true,
 "wipe_orgs":["264fe031-5381-4d70-a8fd-113c1713bc65","2a213c03-c440-450d-9217-e2bbfcaff6b5"],
 "delete_org":"75b27c0c-2e85-486e-b1f4-4e9b9c045ca7",
 "delete_org_audit_ids":["133a7654-e02a-430f-9bbf-a46fa2ab23de","a1c3f71b-2729-4fb5-99f9-79bfb7f5d5f1"],
 "delete_users":[{"id":"6d084998-baad-49d3-b3aa-cad95a26560d","email":"rhumecoaching@gmail.com"},{"id":"dc05fa61-1b18-4892-9abf-43ae651535d8","email":"test@test.com"},{"id":"ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7","email":"test@testmail.com"}],
 "keep_admins":["cabd4289-e7dd-448e-9fed-a7cfab216cda","8703c781-adff-43f5-a258-dc1eb49c2d13"],
 "expected":{"264fe031-5381-4d70-a8fd-113c1713bc65":{"customers":9,"suppliers":9,"quotes":28,"jobs":27,"sales_orders":21,"purchase_orders":10,"delivery_notes":10,"invoices":20,"machines":1,"stock":6},
             "2a213c03-c440-450d-9217-e2bbfcaff6b5":{"customers":1,"quotes":3,"jobs":2,"sales_orders":1,"invoices":1}}}$j$::jsonb);
\echo === fingerprints after dry run vs before (rows listed = differences)
SELECT f.tbl, s.n AS n_before, f.n AS n_after FROM testfx.fp() f JOIN testfx.snap s ON s.tbl=f.tbl AND s.lbl='before' WHERE s.h IS DISTINCT FROM f.h OR s.n<>f.n;
SELECT 'tables_equal' k, count(*) FROM testfx.fp() f JOIN testfx.snap s ON s.tbl=f.tbl AND s.lbl='before' WHERE s.h=f.h AND s.n=f.n;
SELECT 'DATA_WIPE audit rows' k, count(*) FROM security_audit.audit_log WHERE action='DATA_WIPE';
SELECT 'orgs' k, count(*) FROM public.organizations;
