-- =====================================================================================================
-- 008: COMPANY LOGO PER ORGANISATION
-- Each organisation uploads its own document logo (Settings > Company details). Files live in the private
-- bucket org-logos under <organization_id>/..., and organization_settings.company_profile.logoPath holds that
-- object path. Every member of the organisation may read it (all roles print documents); only admins may
-- upload, replace or remove it. The app only loads a logoPath that starts with the signed-in organisation's
-- id, so a document can never show another company's logo; without one it prints the company name.
-- Safe to re-run.
-- =====================================================================================================

DO $do$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE '008: storage schema not found, skipping bucket';
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('org-logos', 'org-logos', FALSE, 1048576, ARRAY['image/png', 'image/jpeg'])
  ON CONFLICT (id) DO UPDATE
    SET public = FALSE, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
END
$do$;

DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "org-logos org select" ON storage.objects;
  DROP POLICY IF EXISTS "org-logos admin insert" ON storage.objects;
  DROP POLICY IF EXISTS "org-logos admin update" ON storage.objects;
  DROP POLICY IF EXISTS "org-logos admin delete" ON storage.objects;

  CREATE POLICY "org-logos org select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'org-logos'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));

  CREATE POLICY "org-logos admin insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'org-logos'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin']));

  CREATE POLICY "org-logos admin update" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'org-logos'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin']))
    WITH CHECK (bucket_id = 'org-logos'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin']));

  CREATE POLICY "org-logos admin delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'org-logos'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin']));
END
$do$;

-- Logos used to be paths to files bundled with the app (e.g. /jnr-doc-logo.png), which any organisation could
-- point at. Drop every logoPath that is not inside that organisation's own folder.
UPDATE public.organization_settings
SET company_profile = company_profile - 'logoPath'
WHERE company_profile ? 'logoPath'
  AND company_profile ->> 'logoPath' NOT LIKE organization_id::TEXT || '/%';

-- Check: the bucket exists and is private, 4 policies, no logoPath outside its own folder (expect 0).
SELECT
  (SELECT public FROM storage.buckets WHERE id = 'org-logos') AS bucket_public,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'org-logos %') AS policies,
  (SELECT count(*) FROM public.organization_settings
    WHERE company_profile ? 'logoPath' AND company_profile ->> 'logoPath' NOT LIKE organization_id::TEXT || '/%') AS foreign_logo_paths;
