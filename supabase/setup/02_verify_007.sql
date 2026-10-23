-- Step 02 (run on quoteflow-prod, READ-ONLY, after 01): check that 007, the import function and the hardening are in place
-- the owner-only functions cannot be called by app users. Every row's "ok" column must be true.

WITH expected(fn, anon_may, authenticated_may) AS (VALUES
  -- owner-only (SQL editor / service role): nobody signed in or out may call these
  ('public.create_organization(text,text,text,jsonb)',              false, false),
  ('public.add_member(uuid,text,text)',                               false, false),
  ('public._ensure_member(uuid,text,uuid,text)',                      false, false),
  ('public._apply_membership_to_profile(uuid,uuid)',                  false, false),
  ('public.handle_new_auth_user()',                                   false, false),
  ('public.platform_org_summary()',                                   false, false),
  ('public.import_legacy_tenant(jsonb,uuid)',                         false, false),
  ('public.reseed_doc_counters()',                                    false, false),
  -- app functions: signed-in users only
  ('public.switch_organization(uuid)',                                false, true),
  ('public.my_organizations()',                                       false, true),
  ('public.org_members()',                                            false, true),
  ('public.set_member_access(uuid,text,boolean)',                     false, true),
  ('public.next_doc_number(text)',                                    false, true),
  ('public.create_with_lines(text,jsonb,text,text,jsonb)',            false, true),
  ('public.has_org_role(text[])',                                     false, true)
)
SELECT e.fn,
       has_function_privilege('anon', e.fn::regprocedure, 'EXECUTE')          AS anon_can,
       has_function_privilege('authenticated', e.fn::regprocedure, 'EXECUTE') AS authenticated_can,
       has_function_privilege('anon', e.fn::regprocedure, 'EXECUTE') = e.anon_may
   AND has_function_privilege('authenticated', e.fn::regprocedure, 'EXECUTE') = e.authenticated_may AS ok
FROM expected e
UNION ALL
SELECT 'table organization_members exists, RLS on', NULL, NULL,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.organization_members')), false)
UNION ALL
SELECT 'table organization_invites exists, RLS on', NULL, NULL,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.organization_invites')), false)
UNION ALL
SELECT 'sign-up trigger on auth.users', NULL, NULL,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_apply_invite' AND tgrelid = 'auth.users'::regclass)
UNION ALL
SELECT 'every public table has RLS on', NULL, NULL,
       NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity)
UNION ALL
SELECT 'anon cannot read organizations / user_profiles / quotes', NULL, NULL,
       NOT has_table_privilege('anon', 'public.organizations', 'SELECT')
   AND NOT has_table_privilege('anon', 'public.user_profiles', 'SELECT')
   AND NOT has_table_privilege('anon', 'public.quotes', 'SELECT');
-- If any row is false, stop and report it before step 03.
