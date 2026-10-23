-- Migration 077 (the audit chain's previous-hash lookup served by an index). Read only: every row should be TRUE.
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.*, regexp_replace(p.prosrc, '\s', '', 'g') AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('security_audit.set_audit_hash()')
),
companies(org) AS (
  SELECT o.id FROM public.organizations o UNION ALL SELECT NULL::UUID
),
next_link AS (
  -- For every company (and the NULL chain): the row 006's lookup picks and the row 077's lookup picks, right now.
  SELECT c.org,
         (SELECT a.hash FROM security_audit.audit_log a WHERE a.organization_id IS NOT DISTINCT FROM c.org ORDER BY a.created_at DESC LIMIT 1) AS by_006,
         CASE WHEN c.org IS NULL
              THEN (SELECT a.hash FROM security_audit.audit_log a WHERE a.organization_id IS NULL ORDER BY a.organization_id, a.created_at DESC LIMIT 1)
              ELSE (SELECT a.hash FROM security_audit.audit_log a WHERE a.organization_id = c.org ORDER BY a.organization_id, a.created_at DESC LIMIT 1)
         END AS by_077
  FROM companies c
)
SELECT 'index_valid' AS check_name, EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indexrelid = to_regclass('security_audit.audit_log_org_created_idx') AND i.indisvalid AND i.indisready AND i.indislive
    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX audit_log_org_created_idx ON security_audit.audit_log USING btree (organization_id, created_at DESC)') AS ok
UNION ALL SELECT 'function_is_077', (SELECT md5(body) = '5f4b0bcedcdf8a8c044e2e78a88a7221' FROM f)
-- The indexable lookups, and 006's unindexable one gone.
UNION ALL SELECT 'lookup_indexable', (SELECT strpos(body, 'IFNEW.organization_idISNULLTHENSELECThashINTOpreviousFROMsecurity_audit.audit_logWHEREorganization_idISNULLORDERBYorganization_id,created_atDESCLIMIT1;') > 0
                                          AND strpos(body, 'ELSESELECThashINTOpreviousFROMsecurity_audit.audit_logWHEREorganization_id=NEW.organization_idORDERBYorganization_id,created_atDESCLIMIT1;ENDIF;') > 0
                                          AND strpos(body, 'WHEREorganization_idISNOTDISTINCTFROM') = 0 FROM f)
-- The same company lock as 006, as the first statement, then created_at, as 006.
UNION ALL SELECT 'same_lock_first', (SELECT strpos(body, 'BEGINPERFORMpg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT,'''')));NEW.created_at:=clock_timestamp();') > 0
                                         AND (length(body) - length(replace(body, 'pg_advisory_xact_lock', ''))) = length('pg_advisory_xact_lock') FROM f)
-- The hash text, field by field, as 006.
UNION ALL SELECT 'same_hash_text', (SELECT strpos(body, 'NEW.previous_hash:=previous;NEW.hash:=encode(digest(coalesce(previous,'''')||coalesce(NEW.organization_id::TEXT,'''')||coalesce(NEW.actor_user_id::TEXT,'''')||NEW.action||NEW.entity_table||coalesce(NEW.entity_id,'''')||coalesce(NEW.old_data::TEXT,'''')||coalesce(NEW.new_data::TEXT,'''')||coalesce(NEW.metadata::TEXT,'''')||NEW.created_at::TEXT,''sha256''),''hex'');RETURNNEW;END;') > 0 FROM f)
UNION ALL SELECT 'definer_and_path', (SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, extensions, security_audit'] AND prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') FROM f)
UNION ALL SELECT 'trigger_unchanged', EXISTS (
  SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid = 'security_audit.audit_log'::regclass AND t.tgname = 'audit_log_set_hash' AND t.tgenabled = 'O'
    AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER audit_log_set_hash BEFORE INSERT ON security_audit.audit_log FOR EACH ROW EXECUTE FUNCTION security_audit.set_audit_hash()')
  AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'security_audit.audit_log'::regclass AND t.tgname = 'audit_log_prevent_mutation' AND t.tgenabled = 'O')
-- Live: for every company and the NULL chain, the next row written would chain to the same row under 006 and 077.
UNION ALL SELECT 'same_previous_row_every_company', (SELECT bool_and(by_006 IS NOT DISTINCT FROM by_077) FROM next_link);
