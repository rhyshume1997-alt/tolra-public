-- 094_activity_one_row_per_change.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 094: the Activity page shows one row per change (Rhys: issuing an invoice showed "Issued" and "Status changed to issued"; a saved
-- customer, an admin's rename of a user and other app saves showed twice). Read time only: no audit row is written, changed or removed
-- (the audit log is append-only and kept for ISO 9001). Needs 080 (org_activity) and 035 (log_named_event, actor_stamp). Independent of
-- 081 to 093 (touches none of their objects). Takes 094 from the per-user display preferences, which become 095.
--
-- WHY. public.org_activity (the admin Activity page; 035, then 080) lists every row of the company's security_audit.audit_log but for
-- bookkeeping-only updates. Two kinds of row describe a change the database has already recorded as a row change
-- (security_audit.log_row_change, the AFTER trigger on every audited table: 000, 013 and each later table's own file):
--   a. The app's own note of the same save: write_audit with action CREATE / UPDATE / DELETE (the pages' auditEvent after a save,
--      app/api/admin/users/route.ts after a rename, ...). record_activity (035, a record's own history) has hidden these since 035;
--      org_activity never did.
--   b. A named event the stamp trigger writes for the very UPDATE it stamps (035 public.actor_stamp, BEFORE UPDATE: ISSUE on invoices
--      and credit notes, MARK_PAID and RESEND on invoices, RESEND on quotes, CONFIRM on sales orders, REOPEN on jobs). The row change
--      of that UPDATE is written by the AFTER trigger straight after it, in the same statement: the named event says what happened
--      ("Issued"), the row change says it again ("Status changed to issued").
--
-- WHAT CHANGES. public.org_activity: 080's body byte for byte plus two read-time filters (and the variable the first one uses). Same
-- signature, RETURNS, STABLE, SECURITY DEFINER, search_path, admin-only check, labels, redaction, ordering, limit and grants.
--   a. A write_audit row with action CREATE / UPDATE / INSERT / DELETE is not listed when its table has the log_row_change trigger
--      (read from pg_trigger at call time). On any other table (email_history, organization_settings: 058's and 072's UPDATE events)
--      it is still the only record of the change and is listed as before.
--   b. A database row change (UPDATE) is not listed when the row immediately before it in the company's chain (the row whose hash is
--      its previous_hash, 006's chain: the company's rows are written one transaction at a time under 006's advisory lock) is one of
--      those stamp events (ISSUE, MARK_PAID, RESEND, CONFIRM, REOPEN: written only by actor_stamp) on the same record by the same
--      person. The named event is listed. Anything else (another event, another record, a row in between) is listed as before.
-- Every condition reads only the row and its stored predecessor (never the page's filters), so a row is either always listed or never,
-- and "Load more" (created_at, id) pages exactly as before. record_activity (a record's own history) is unchanged.
-- GUARD (section 1): org_activity must be 080's (or already 094's), md5 with every whitespace character removed. Safe to run again.
-- SELF-CHECK (section 3): the body is 094's; SECURITY DEFINER, STABLE, the fixed search_path; signed-in only.
-- Rollback: supabase/release/094_activity_one_row_per_change.rollback.sql (080's org_activity back; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: the function being replaced is 080's (or already 094's).
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)');
  -- ae7e2416...: 080's body; b4c46509fab9c5746b74bfd3afa30e00...: this file's body (section 2); both with every whitespace character removed.
  IF v_md5 IS NULL OR v_md5 NOT IN ('ae7e2416ce0a54b0d8ccb721aeb2d245', 'b4c46509fab9c5746b74bfd3afa30e00') THEN
    RAISE EXCEPTION '094: public.org_activity is not 080''s (md5 without whitespace %); stop and compare it first', coalesce(v_md5, 'missing');
  END IF;
  IF to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regprocedure('security_audit.activity_label(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '094: security_audit.log_row_change (000) or activity_label(text, jsonb) (080) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. org_activity: 080's (supabase/migrations/080_activity_labels_job_work.sql section 3) plus the two filters marked 094.
CREATE OR REPLACE FUNCTION public.org_activity(
  p_from   TIMESTAMPTZ DEFAULT NULL,
  p_to     TIMESTAMPTZ DEFAULT NULL,
  p_actor  UUID        DEFAULT NULL,
  p_table  TEXT        DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,   -- "load more": the last row shown (time + id)
  p_before_id UUID     DEFAULT NULL,
  p_limit  INTEGER     DEFAULT 100
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, actor_user_id UUID, actor_name TEXT, actor_email TEXT, action TEXT,
               entity_table TEXT, entity_id TEXT, record_table TEXT, record_id TEXT, record_label TEXT,
               changes JSONB, snapshot JSONB, metadata JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_row_audited TEXT[];
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can view the activity log' USING ERRCODE = '42501';
  END IF;
  -- 094: the tables whose every row change the database records itself (security_audit.log_row_change).
  v_row_audited := ARRAY(SELECT DISTINCT c.relname::TEXT FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         WHERE c.relnamespace = 'public'::regnamespace AND t.tgfoid = 'security_audit.log_row_change()'::regprocedure);

  RETURN QUERY
  SELECT a.id, a.created_at, a.actor_user_id,
         CASE WHEN a.actor_user_id IS NULL THEN 'System' ELSE cp.display_name END,
         NULL::TEXT, a.action, a.entity_table, a.entity_id,
         CASE a.entity_table
           WHEN 'quote_line_items' THEN 'quotes' WHEN 'quote_attachments' THEN 'quotes'
           WHEN 'invoice_line_items' THEN 'invoices' WHEN 'delivery_note_items' THEN 'delivery_notes'
           WHEN 'machine_bookings' THEN 'jobs' WHEN 'job_values' THEN 'jobs'
           ELSE a.entity_table END,
         CASE WHEN a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values')
              THEN security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              ELSE a.entity_id END,
         security_audit.redact_emails(to_jsonb(coalesce(pl.parent_label, security_audit.activity_label(a.entity_table, coalesce(a.new_data, a.old_data)))), v_org) #>> '{}',
         security_audit.redact_emails(CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END, v_org),
         security_audit.redact_emails(CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
              WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
         END, v_org),
         security_audit.redact_emails(a.metadata - 'source', v_org)
  FROM security_audit.audit_log a
  LEFT JOIN public.company_people() cp ON cp.user_id = a.actor_user_id
  -- Child rows (lines, attachments, bookings) are labelled with their record's number.
  LEFT JOIN LATERAL (
    SELECT CASE a.entity_table
      WHEN 'quote_line_items'    THEN (SELECT q.quote_ref FROM public.quotes q WHERE q.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND q.organization_id = v_org)
      WHEN 'invoice_line_items'  THEN (SELECT i.invoice_ref FROM public.invoices i WHERE i.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND i.organization_id = v_org)
      WHEN 'delivery_note_items' THEN (SELECT d.dn_number FROM public.delivery_notes d WHERE d.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND d.organization_id = v_org)
      WHEN 'machine_bookings'    THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'job_values'          THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'quote_attachments'   THEN coalesce(a.new_data ->> 'quote_ref', a.old_data ->> 'quote_ref')
    END AS parent_label
  ) pl ON TRUE
  WHERE a.organization_id = v_org
    AND (p_from IS NULL OR a.created_at >= p_from)
    AND (p_to IS NULL OR a.created_at < p_to)
    AND (p_before IS NULL OR (a.created_at, a.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID)))
    AND (p_actor IS NULL OR a.actor_user_id = p_actor)
    AND (p_table IS NULL OR a.entity_table = p_table
         OR (p_table = 'quotes' AND a.entity_table IN ('quote_line_items', 'quote_attachments'))
         OR (p_table = 'invoices' AND a.entity_table = 'invoice_line_items')
         OR (p_table = 'delivery_notes' AND a.entity_table = 'delivery_note_items')
         OR (p_table = 'jobs' AND a.entity_table IN ('machine_bookings', 'job_values')))
    AND NOT (a.action = 'UPDATE' AND security_audit.activity_changes(a.old_data, a.new_data) = '{}'::JSONB)
    -- 094 (a): the app's own create / update / delete note (write_audit) on a table whose row change the database already records
    AND NOT (coalesce(a.metadata ->> 'source', '') = 'write_audit' AND a.action IN ('CREATE', 'UPDATE', 'INSERT', 'DELETE')
             AND a.entity_table = ANY (v_row_audited))
    -- 094 (b): the row change of an update its own stamp trigger (035 actor_stamp) has just named: the named event is the row
    -- immediately before it in the company's chain (its hash is this row's previous_hash), on the same record, by the same person
    AND NOT (a.action = 'UPDATE' AND coalesce(a.metadata ->> 'source', '') = 'database_trigger' AND a.previous_hash IS NOT NULL
             AND EXISTS (SELECT 1
                         FROM (SELECT p.hash, p.action, p.entity_table, p.entity_id, p.actor_user_id, p.metadata
                               FROM security_audit.audit_log p
                               WHERE p.organization_id = a.organization_id AND p.created_at < a.created_at
                               ORDER BY p.organization_id, p.created_at DESC
                               LIMIT 1) n
                         WHERE n.hash = a.previous_hash
                           AND n.action IN ('ISSUE', 'MARK_PAID', 'RESEND', 'CONFIRM', 'REOPEN')
                           AND coalesce(n.metadata ->> 'source', '') = 'write_audit'
                           AND n.entity_table = a.entity_table AND n.entity_id = a.entity_id
                           AND n.actor_user_id IS NOT DISTINCT FROM a.actor_user_id))
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check: the body is 094's, definer, STABLE, with 080's search_path; signed-in only.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b4c46509fab9c5746b74bfd3afa30e00' OR NOT p.prosecdef OR p.provolatile <> 's'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, security_audit']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')) THEN
    RAISE EXCEPTION '094: org_activity is not 094''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)') AND a.grantee = 0) THEN
    RAISE EXCEPTION '094: org_activity is not signed-in only';
  END IF;
END
$$;

COMMIT;
