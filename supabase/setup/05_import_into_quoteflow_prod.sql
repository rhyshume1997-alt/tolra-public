-- Step 05: run on quoteflow-prod (the production project).
-- 1. Paste the JSON copied from step 04 between the two $legacy$ markers (replace the PASTE line).
-- 2. Run. The result is a report: rows inserted per table, rows matched/skipped, unmatched profiles.
--
-- Everything goes into the JNR Engineering organisation only. Safe to re-run (already-imported rows are skipped).
-- Legacy users who haven't signed in to quoteflow-prod yet show under "unmatched_profiles": that's expected.
-- Their access comes from the invites created in step 03. The two @jnr.test logins are test accounts and stay
-- unmatched on purpose.

SELECT public.import_legacy_tenant(
  $legacy$
PASTE_THE_EXPORT_JSON_HERE
  $legacy$::jsonb,
  (SELECT id FROM public.organizations WHERE slug = 'jnr-engineering')
);
