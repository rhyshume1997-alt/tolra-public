-- READ ONLY. Migration 045 (operator sign-off, M4): run in a read-only transaction AFTER applying 045 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 14 are facts about the schema and must be "true". Row 15 is informational: how many
-- sign-offs exist.
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.proconfig, p.provolatile, p.proacl, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'job_signoffs exists with row-level security on' AS check_name,
      (SELECT count(*) = 1 AND bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'job_signoffs')::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'The API roles can only read it (no insert, update or delete privilege for anon or authenticated)',
      (SELECT count(*) = 0 FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public' AND g.table_name = 'job_signoffs' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC') AND g.privilege_type <> 'SELECT')::text, 'true'
  UNION ALL SELECT 3, 'sign_off_job exists once, is SECURITY DEFINER with a fixed search_path, and is closed to anon',
      (SELECT count(*) = 1 AND bool_and(prosecdef) AND bool_and(array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public, security_audit, extensions%')
              AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname = 'sign_off_job')::text, 'true'
  UNION ALL SELECT 4, 'canonical_jsonb exists once and is IMMUTABLE',
      (SELECT count(*) = 1 AND bool_and(provolatile = 'i') FROM fn WHERE proname = 'canonical_jsonb')::text, 'true'
  UNION ALL SELECT 5, 'canonical_jsonb gives the agreed text and hash (the same vector as tests/unit/snapshot-hash.test.ts)',
      (public.canonical_jsonb('{"b": "1", "a": ["z", "y"], "c": {"y": true, "x": null}}'::jsonb) = '{"a":["z","y"],"b":"1","c":{"x":null,"y":true}}'
       AND encode(extensions.digest(convert_to(public.canonical_jsonb('""'::jsonb), 'UTF8'), 'sha256'), 'hex') = '12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126')::text, 'true'
  UNION ALL SELECT 6, 'Records can''t be changed or removed (the immutability trigger on UPDATE, DELETE and TRUNCATE)',
      (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.job_signoffs'::regclass AND NOT t.tgisinternal
         AND t.tgname IN ('job_signoffs_immutable', 'job_signoffs_no_truncate'))::text, 'true'
  UNION ALL SELECT 7, 'Same-company, audit, support read-only and admin MFA triggers are on job_signoffs',
      (SELECT count(*) = 4 FROM pg_trigger t WHERE t.tgrelid = 'public.job_signoffs'::regclass AND NOT t.tgisinternal
         AND t.tgname IN ('zz_same_org_job_id', 'audit_job_signoffs_changes', 'support_read_only', 'admin_mfa'))::text, 'true'
  UNION ALL SELECT 8, 'job_id is ON DELETE RESTRICT (jobs are archived, never deleted)',
      (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.job_signoffs'::regclass AND c.contype = 'f'
         AND c.confrelid = 'public.jobs'::regclass AND c.confdeltype = 'r')::text, 'true'
  UNION ALL SELECT 9, 'One primary and at most one co-signature per role on a revision: UNIQUE (job_id, worksheet_version, kind), kind primary or inspector',
      ((SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.job_signoffs'::regclass AND c.contype = 'u'
         AND c.conname = 'job_signoffs_one_per_kind' AND pg_get_constraintdef(c.oid) = 'UNIQUE (job_id, worksheet_version, kind)')::text
       || ',' || (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.job_signoffs'::regclass AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%kind%primary%inspector%' AND pg_get_constraintdef(c.oid) NOT LIKE '%signature_kind%')::text
       = 'true,true')::text, 'true'
  UNION ALL SELECT 10, 'sign_off_job is bound to a frozen revision and a client key: (job, expected version, expected snapshot hash, ..., kind, client key)',
      (SELECT count(*) = 1 AND bool_and(oid::regprocedure::text = 'sign_off_job(uuid,integer,text,text,text,date,text,text,text,uuid)')
              AND bool_and(proargnames[3] = 'p_expected_snapshot_sha256' AND proargnames[10] = 'p_client_op_id')
       FROM (SELECT p.oid, p.proargnames FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sign_off_job') f)::text, 'true'
  UNION ALL SELECT 11, 'job_signoff_revision exists once, is SECURITY DEFINER and STABLE, executable by authenticated only (not anon, not PUBLIC)',
      (SELECT count(*) = 1 AND bool_and(prosecdef) AND bool_and(provolatile = 's') AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
       FROM fn WHERE proname = 'job_signoff_revision')::text, 'true'
  UNION ALL SELECT 12, 'The internal helpers (canonical_jsonb, job_signoff_snapshot) are not executable by anon or authenticated, and sign_off_job not by PUBLIC',
      ((SELECT count(*) = 2 AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE'))
        FROM fn WHERE proname IN ('canonical_jsonb', 'job_signoff_snapshot'))
       AND (SELECT NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) FROM fn WHERE proname = 'sign_off_job'))::text, 'true'
  UNION ALL SELECT 13, 'A client key makes one record per company: UNIQUE (organization_id, client_op_id)',
      (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.job_signoffs'::regclass AND c.contype = 'u'
         AND c.conname = 'job_signoffs_client_op' AND pg_get_constraintdef(c.oid) = 'UNIQUE (organization_id, client_op_id)')::text, 'true'
  UNION ALL SELECT 14, 'Signatures are inline in the immutable row (signature_data text with its shape CHECK); no Storage bucket or storage policy for signatures',
      ((SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_signoffs' AND column_name = 'signature_data' AND data_type = 'text')
       AND (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.job_signoffs'::regclass AND c.conname = 'job_signoffs_signature_shape')
       AND (SELECT count(*) = 0 FROM storage.buckets b WHERE b.id ILIKE '%sign%' OR b.name ILIKE '%sign%')
       AND (SELECT count(*) = 0 FROM pg_policies p WHERE p.schemaname = 'storage' AND (p.policyname ILIKE '%sign%' OR coalesce(p.qual, '') ILIKE '%signoff%' OR coalesce(p.with_check, '') ILIKE '%signoff%')))::text, 'true'
  UNION ALL SELECT 15, 'Sign-offs recorded (informational)', (SELECT count(*) FROM public.job_signoffs)::text, 'any'
) checks ORDER BY n;
