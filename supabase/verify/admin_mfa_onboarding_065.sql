-- Migration 065 (admin two-step sign-in onboarding). Read only: every readiness row should be TRUE.
-- The second query lists, per company, the active admins who have NOT set up an authenticator app (who would block
-- require_admin_mfa from being turned on). Emails only; nothing is changed.
SELECT 'flag_column' AS check_name, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organization_members' AND column_name = 'mfa_enrolment_required'
    AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false'
) AS ok
UNION ALL SELECT 'flag_trigger', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_members'::regclass
    AND tgname = 'organization_members_mfa_enrolment' AND tgenabled = 'O'
)
UNION ALL SELECT 'rule_guard_trigger', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass
    AND tgname = 'organizations_require_admin_mfa_guard' AND tgenabled = 'O'
)
-- The functions' owner can read the Auth factor table (the guard and the status functions depend on it).
UNION ALL SELECT 'owner_reads_factors', (
  SELECT has_table_privilege(p.proowner, 'auth.mfa_factors', 'SELECT')
  FROM pg_proc p WHERE p.oid = 'public.member_has_verified_totp(uuid)'::regprocedure
)
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('member_has_verified_totp', 'organization_members_mfa_enrolment', 'organizations_require_admin_mfa_guard')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
)
UNION ALL SELECT 'readers_for_signed_in_only', (
  SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND p.prosecdef)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('admin_mfa_overview', 'my_mfa_enrolment_required')
) AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('admin_mfa_overview', 'my_mfa_enrolment_required')) = 2
-- Nobody is flagged on apply (the column defaults to FALSE; only admins given admin from now on are).
UNION ALL SELECT 'flag_only_on_admins', NOT EXISTS (
  SELECT 1 FROM public.organization_members m
  WHERE m.mfa_enrolment_required AND NOT (m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, '')))
)
-- A company that already requires the second step has every active admin enrolled (else the rule was on before 065).
UNION ALL SELECT 'rule_on_means_all_enrolled', NOT EXISTS (
  SELECT 1 FROM public.organizations o JOIN public.organization_members m ON m.organization_id = o.id
  WHERE o.require_admin_mfa AND m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
    AND NOT public.member_has_verified_totp(m.user_id)
);

SELECT o.slug AS company, p.email AS admin_without_authenticator, m.mfa_enrolment_required AS sent_to_set_up_at_next_sign_in
FROM public.organization_members m
JOIN public.organizations o ON o.id = m.organization_id
LEFT JOIN public.user_profiles p ON p.id = m.user_id
WHERE m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
  AND NOT public.member_has_verified_totp(m.user_id)
ORDER BY o.slug, p.email;
