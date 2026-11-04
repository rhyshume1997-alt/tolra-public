-- Read only: after a separately approved release 147, every row must say true.
SELECT 'create_job_delivery_note is security definer with a pinned search path' AS check_name,
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)')), false) AS ok
UNION ALL SELECT 'authenticated may call it; anon and PUBLIC may not',
  has_function_privilege('authenticated', 'public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = to_regprocedure('public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)') AND a.grantee = 0)
UNION ALL SELECT 'it checks the role, the second step and the release before numbering',
  coalesce((SELECT prosrc LIKE '%assert_privileged_aal()%' AND prosrc LIKE '%has_org_role(ARRAY[''admin'', ''office'', ''workshop''])%'
                   AND prosrc LIKE '%job_release_state(v_job.id)%' AND position('job_release_state(v_job.id)' IN prosrc) < position('next_doc_number(''DLN'')' IN prosrc)
            FROM pg_proc WHERE oid = to_regprocedure('public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)')), false)
UNION ALL SELECT 'request key column and per-company unique index',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery_notes' AND column_name = 'request_id' AND data_type = 'uuid')
  AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'delivery_notes_org_request_uniq' AND indexdef LIKE 'CREATE UNIQUE INDEX%(organization_id, request_id) WHERE (request_id IS NOT NULL)')
UNION ALL SELECT 'request key guard trigger enabled and not callable by browser roles',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgname = 'delivery_notes_request_guard' AND tgenabled = 'O'
          AND tgfoid = to_regprocedure('public.delivery_notes_request_guard()'))
  AND NOT has_function_privilege('authenticated', 'public.delivery_notes_request_guard()', 'EXECUTE')
UNION ALL SELECT 'release gate still on delivery notes (inspection must pass unless an admin releases early)',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgname = 'delivery_notes_release_gate' AND tgenabled = 'O'
          AND tgfoid = to_regprocedure('public.delivery_notes_release_gate()'))
UNION ALL SELECT 'link guard still on delivery notes',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgname = 'delivery_notes_link_guard' AND tgenabled = 'O')
UNION ALL SELECT 'same-company triggers on job_id and customer_id',
  (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgenabled = 'O'
   AND tgname IN ('zz_same_org_job_id', 'zz_same_org_customer_id') AND tgfoid = to_regprocedure('public.enforce_same_org_parent()'))
UNION ALL SELECT 'row audit still on delivery notes',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgname = 'audit_delivery_notes_changes' AND tgenabled = 'O')
UNION ALL SELECT 'row security on delivery notes and items',
  (SELECT count(*) = 2 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.delivery_notes'::regclass, 'public.delivery_note_items'::regclass))
UNION ALL SELECT 'no note links a job or customer of another company',
  NOT EXISTS (SELECT 1 FROM public.delivery_notes d LEFT JOIN public.jobs j ON j.id = d.job_id LEFT JOIN public.customers c ON c.id = d.customer_id
              WHERE d.request_id IS NOT NULL AND (j.organization_id IS DISTINCT FROM d.organization_id OR c.organization_id IS DISTINCT FROM d.organization_id));
-- Also run tests/db/job-delivery-note-147.test.ts against a disposable database, never a live tenant.
