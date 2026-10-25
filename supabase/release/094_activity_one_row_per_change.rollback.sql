-- 094 rollback: ONLY with Rhys's approval. Puts back 080's public.org_activity byte for byte (same signature, security and grants): the
-- Activity page then lists the app's own create / update notes and the stamp-trigger row changes beside their named events again
-- (the double rows 094 hides). No audit row is touched either way. Run the whole text as one transaction, then the release preflight
-- (marker 094 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)');
  -- a29b5655...: 094's body; ae7e2416...: 080's (a second run of this rollback).
  IF v_md5 IS NULL OR v_md5 NOT IN ('a29b5655c21474b4b40d54760de5a9c4', 'ae7e2416ce0a54b0d8ccb721aeb2d245') THEN
    RAISE EXCEPTION '094 rollback: org_activity (md5 %) is neither 094''s nor 080''s; stop and compare', coalesce(v_md5, 'missing');
  END IF;
END
$$;

-- 080's definition, verbatim (supabase/migrations/080_activity_labels_job_work.sql section 3).
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
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can view the activity log' USING ERRCODE = '42501';
  END IF;

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
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'ae7e2416ce0a54b0d8ccb721aeb2d245' OR NOT p.prosecdef OR p.provolatile <> 's'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, security_audit']
             OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')) THEN
    RAISE EXCEPTION '094 rollback: org_activity is not 080''s afterwards';
  END IF;
END
$$;
COMMIT;
