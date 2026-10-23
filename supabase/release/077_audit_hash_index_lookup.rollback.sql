-- 077 rollback: puts back 006's security_audit.set_audit_hash() byte for byte (the whole-log scan and sort). Safe at any time: rows
-- written under 077 are chained exactly as 006 would have chained them (same lock, same previous row, same hash), so nothing written
-- since 077 needs undoing and no row is touched here. audit_log_org_created_idx stays: it has existed since 000 (other reads use it),
-- and 077 only built it if it was missing. Run the whole text as one transaction, then the release preflight (077 shows "not applied").
BEGIN;
DO $$
BEGIN
  -- Only 077's function (or 006's again, a second run) is replaced; anything else is looked at first.
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('security_audit.set_audit_hash()'))
     IS DISTINCT FROM '5f4b0bcedcdf8a8c044e2e78a88a7221'
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('security_audit.set_audit_hash()'))
     IS DISTINCT FROM 'f52ea7c6a9b6178d866b73e7a84d784e' THEN
    RAISE EXCEPTION '077 rollback: security_audit.set_audit_hash() is neither 077''s nor 006''s; stop and compare it first';
  END IF;
END
$$;

-- 006's definition, verbatim (supabase/migrations/006_production_hardening.sql).
CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, security_audit
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT, '')));

  NEW.created_at := clock_timestamp();

  SELECT hash
  INTO previous
  FROM security_audit.audit_log
  WHERE organization_id IS NOT DISTINCT FROM NEW.organization_id
  ORDER BY created_at DESC
  LIMIT 1;

  NEW.previous_hash := previous;
  NEW.hash := encode(
    digest(
      coalesce(previous, '') ||
      coalesce(NEW.organization_id::TEXT, '') ||
      coalesce(NEW.actor_user_id::TEXT, '') ||
      NEW.action ||
      NEW.entity_table ||
      coalesce(NEW.entity_id, '') ||
      coalesce(NEW.old_data::TEXT, '') ||
      coalesce(NEW.new_data::TEXT, '') ||
      coalesce(NEW.metadata::TEXT, '') ||
      NEW.created_at::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;
COMMIT;
