-- p171 (proposed release 171, after 170 in supabase/release-plan.json): editable ISO documents inside Tolra (module 9, owner-approved 26 Nov).
-- PROPOSAL ONLY. Not applied to production. Rehearsed on the scratch database only: supabase/proposals/p171_iso_editable_documents.rehearsal.md.
-- Rollback: supabase/proposals/p171_iso_editable_documents.rollback.sql.
--
-- INPUTS: none. OUTPUTS (all new): one table and four functions:
--   public.iso_document_versions        append-only versions of the nine ISO draft documents, per company.
--   public.iso_document_caller()        internal guard (no grant to any browser role): the caller's company, or a refusal.
--   public.save_iso_document(...)       admin of the caller's own company: appends a NEW draft version (never edits an old one).
--   public.approve_iso_document(...)    admin of the caller's own company: marks one draft version Approved (name + now()).
--   public.iso_document_versions_guard() trigger function: the table is append-only; the ONLY update allowed is draft -> approved.
-- DESIGN (one table, one transition): approval is the single permitted UPDATE of a row (status draft->approved and the three approved_*
--   columns, nothing else changes), enforced by a trigger for EVERY role. A separate approvals table was not used: "latest approved" and the
--   locked flag then come from one row with no join, and a version can never be approved without existing. The text, version number,
--   author, note and created_at of a row never change after insert. An approved version is therefore locked; editing starts a new draft
--   version (the app passes the approved text as the base of the next save).
-- WHO CAN DO WHAT:
--   * READ (row-level security): an active ADMIN of the session's own company reads that company's rows only. Office, workshop, viewer,
--     anon and every other company get nothing. Select is wrapped (SELECT ...) so it is evaluated once per statement (as 131 does).
--   * WRITE: no INSERT/UPDATE/DELETE/TRUNCATE grant for any browser role and no write policy. Only the two functions write, as SECURITY
--     DEFINER with search_path pg_catalog, public. Both: signed in, passed the second step (assert_privileged_aal), a session company,
--     role admin (primary or secondary, has_org_role), NOT a support session and NOT read-only. Company and person always come from
--     the session, never from the caller; display name comes from user_profiles (full name, else e-mail).
--   * save: doc_id one of the nine ids; 1 to 30 sections, each {heading, text} (heading 1..200, text 0..20000 characters); the whole body at
--     most 200000 bytes; change note at most 500 characters; version = highest + 1 for (company, document), taken under an advisory lock;
--     optional p_base_version refuses (40001) when someone saved a newer version since the editor loaded.
--   * approve: refuses an unknown version (P0002) or an already approved one (55000, hint already_approved); approver name 1..200 characters.
-- AUDIT: each save and each approval writes one security_audit.audit_log row from inside the function (the audit trigger that records
--   to_jsonb(NEW) was deliberately NOT attached, because it would copy the whole document text into the audit log). The row holds the
--   action, document id, version, status and text length only, never the text.
-- MUST NOT CHANGE: any existing table, column, policy, trigger, function or grant. Nothing is gated here (the app keeps it behind the
--   iso-templates company switch and treats a missing table or function as "editing is not available yet").
-- NOTE for the data wipe: public.iso_document_versions has an organization_id, so supabase/cutover/wipe_operational_data.sql must list it
--   as KEPT (company records, not operational data) before a wipe is run, or the script refuses (see the report).
BEGIN;

-- ---- 1. The table ---------------------------------------------------------------------------------------------------------------
CREATE TABLE public.iso_document_versions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  doc_id               TEXT NOT NULL CONSTRAINT iso_document_versions_doc_id CHECK (doc_id IN (
                         'quality-policy', 'qms-scope', 'documented-information', 'external-providers', 'production',
                         'nonconforming-outputs', 'corrective-action', 'records-index', 'internal-audit-checklist')),
  version              INTEGER NOT NULL CONSTRAINT iso_document_versions_version CHECK (version >= 1),
  body                 JSONB NOT NULL CONSTRAINT iso_document_versions_body CHECK (
                         jsonb_typeof(body) = 'object' AND jsonb_typeof(body -> 'sections') = 'array'
                         AND jsonb_array_length(body -> 'sections') BETWEEN 1 AND 30 AND octet_length(body::TEXT) <= 200000),
  change_note          TEXT CONSTRAINT iso_document_versions_note CHECK (change_note IS NULL OR char_length(change_note) <= 500),
  restored_from        INTEGER CONSTRAINT iso_document_versions_restored CHECK (restored_from IS NULL OR restored_from >= 1),
  status               TEXT NOT NULL DEFAULT 'draft' CONSTRAINT iso_document_versions_status CHECK (status IN ('draft', 'approved')),
  -- Plain uuid, no foreign key: a deleted login must never cascade into (or be blocked by) an append-only record.
  created_by           UUID NOT NULL,
  created_by_name      TEXT NOT NULL CONSTRAINT iso_document_versions_by_name CHECK (char_length(created_by_name) BETWEEN 1 AND 200),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by          UUID,
  approved_by_name     TEXT CONSTRAINT iso_document_versions_approver_name CHECK (approved_by_name IS NULL OR char_length(approved_by_name) BETWEEN 1 AND 200),
  approved_at          TIMESTAMPTZ,
  CONSTRAINT iso_document_versions_unique_version UNIQUE (organization_id, doc_id, version),
  CONSTRAINT iso_document_versions_approval_fits CHECK (
    (status = 'approved') = (approved_by IS NOT NULL AND approved_by_name IS NOT NULL AND approved_at IS NOT NULL)
    AND (status = 'approved' OR (approved_by IS NULL AND approved_by_name IS NULL AND approved_at IS NULL)))
);

-- ---- 2. Row security and grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.iso_document_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.iso_document_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.iso_document_versions TO authenticated;
CREATE POLICY "iso_document_versions admin select" ON public.iso_document_versions FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin'])));

-- ---- 3. Append-only guard (every role) ------------------------------------------------------------------------------------------
CREATE FUNCTION public.iso_document_versions_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Browser sessions can never delete. Removing a whole company (service role / owner, cascade) stays possible.
    IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'ISO document versions cannot be deleted.' USING ERRCODE = '42501', HINT = 'append_only';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: only draft -> approved, and nothing but the three approval columns and status may differ.
  IF OLD.status = 'draft' AND NEW.status = 'approved'
     AND NEW.id = OLD.id AND NEW.organization_id = OLD.organization_id AND NEW.doc_id = OLD.doc_id AND NEW.version = OLD.version
     AND NEW.body = OLD.body AND NEW.change_note IS NOT DISTINCT FROM OLD.change_note AND NEW.restored_from IS NOT DISTINCT FROM OLD.restored_from
     AND NEW.created_by = OLD.created_by AND NEW.created_by_name = OLD.created_by_name AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ISO document versions are append-only; only a draft can be approved.' USING ERRCODE = '42501', HINT = 'append_only';
END
$$;
REVOKE ALL ON FUNCTION public.iso_document_versions_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER iso_document_versions_guard BEFORE UPDATE OR DELETE ON public.iso_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.iso_document_versions_guard();

-- ---- 4. Caller guard (internal) -------------------------------------------------------------------------------------------------
CREATE FUNCTION public.iso_document_caller()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_session JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  SELECT public.my_session() INTO v_session;
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((v_session ->> 'support')::BOOLEAN, FALSE) OR coalesce((v_session ->> 'read_only')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.iso_document_caller() FROM PUBLIC, anon, authenticated;

-- ---- 5. Save: always a NEW version ----------------------------------------------------------------------------------------------
CREATE FUNCTION public.save_iso_document(p_doc_id TEXT, p_body JSONB, p_change_note TEXT DEFAULT NULL, p_base_version INTEGER DEFAULT NULL, p_restored_from INTEGER DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.iso_document_caller();
  v_uid   UUID := auth.uid();
  v_name  TEXT;
  v_note  TEXT := nullif(btrim(coalesce(p_change_note, '')), '');
  v_max   INTEGER;
  v_row   public.iso_document_versions;
BEGIN
  IF p_doc_id IS NULL OR p_doc_id NOT IN ('quality-policy', 'qms-scope', 'documented-information', 'external-providers', 'production',
                                           'nonconforming-outputs', 'corrective-action', 'records-index', 'internal-audit-checklist') THEN
    RAISE EXCEPTION 'Unknown document' USING ERRCODE = '22023';
  END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR jsonb_typeof(p_body -> 'sections') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_body -> 'sections') NOT BETWEEN 1 AND 30 OR octet_length(p_body::TEXT) > 200000
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_body -> 'sections') s
                WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s -> 'heading') IS DISTINCT FROM 'string' OR jsonb_typeof(s -> 'text') IS DISTINCT FROM 'string'
                   OR char_length(s ->> 'heading') NOT BETWEEN 1 AND 200 OR char_length(s ->> 'text') > 20000) THEN
    RAISE EXCEPTION 'Invalid document text' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Change note too long' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Unknown') INTO v_name FROM public.user_profiles p WHERE p.id = v_uid;
  v_name := left(coalesce(v_name, 'Unknown'), 200);

  PERFORM pg_advisory_xact_lock(hashtextextended('iso-doc:' || v_org::TEXT || ':' || p_doc_id, 0));
  SELECT coalesce(max(v.version), 0) INTO v_max FROM public.iso_document_versions v WHERE v.organization_id = v_org AND v.doc_id = p_doc_id;
  IF p_base_version IS NOT NULL AND p_base_version IS DISTINCT FROM v_max THEN
    RAISE EXCEPTION 'This document changed since you opened it; reload before saving' USING ERRCODE = '40001', HINT = 'stale_version';
  END IF;
  IF p_restored_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.iso_document_versions v WHERE v.organization_id = v_org AND v.doc_id = p_doc_id AND v.version = p_restored_from) THEN
    RAISE EXCEPTION 'Unknown version to restore' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.iso_document_versions (organization_id, doc_id, version, body, change_note, restored_from, status, created_by, created_by_name)
  VALUES (v_org, p_doc_id, v_max + 1, p_body, v_note, p_restored_from, 'draft', v_uid, v_name)
  RETURNING * INTO v_row;

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, new_data, metadata)
  VALUES (v_org, v_uid, nullif(auth.jwt() ->> 'email', ''), 'iso_document.save', 'iso_document_versions', v_row.id::TEXT,
          jsonb_build_object('doc_id', v_row.doc_id, 'version', v_row.version, 'status', v_row.status, 'text_length', length(v_row.body::TEXT)),
          jsonb_build_object('source', 'iso_document_function'));

  RETURN jsonb_build_object('id', v_row.id, 'doc_id', v_row.doc_id, 'version', v_row.version, 'status', v_row.status, 'created_at', v_row.created_at);
END
$$;
REVOKE ALL ON FUNCTION public.save_iso_document(TEXT, JSONB, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_iso_document(TEXT, JSONB, TEXT, INTEGER, INTEGER) TO authenticated;

-- ---- 6. Approve: the one allowed transition -------------------------------------------------------------------------------------
CREATE FUNCTION public.approve_iso_document(p_doc_id TEXT, p_version INTEGER, p_approver_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public.iso_document_caller();
  v_uid  UUID := auth.uid();
  v_name TEXT := btrim(coalesce(p_approver_name, ''));
  v_row  public.iso_document_versions;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Approver name is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.iso_document_versions v
   WHERE v.organization_id = v_org AND v.doc_id = p_doc_id AND v.version = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status = 'approved' THEN
    RAISE EXCEPTION 'This version is already approved' USING ERRCODE = '55000', HINT = 'already_approved';
  END IF;
  UPDATE public.iso_document_versions SET status = 'approved', approved_by = v_uid, approved_by_name = v_name, approved_at = now()
   WHERE id = v_row.id RETURNING * INTO v_row;

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, new_data, metadata)
  VALUES (v_org, v_uid, nullif(auth.jwt() ->> 'email', ''), 'iso_document.approve', 'iso_document_versions', v_row.id::TEXT,
          jsonb_build_object('doc_id', v_row.doc_id, 'version', v_row.version, 'status', v_row.status),
          jsonb_build_object('source', 'iso_document_function'));

  RETURN jsonb_build_object('id', v_row.id, 'doc_id', v_row.doc_id, 'version', v_row.version, 'status', v_row.status,
                            'approved_by_name', v_row.approved_by_name, 'approved_at', v_row.approved_at);
END
$$;
REVOKE ALL ON FUNCTION public.approve_iso_document(TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_iso_document(TEXT, INTEGER, TEXT) TO authenticated;
COMMIT;
