-- =====================================================================================================
-- 026: recording a delivery note e-mail is all-or-nothing and only says "sent" when someone confirms it
--      (audit B7a: A6, D17).
--
-- Before: the page stamped delivery_notes.emailed_at, then inserted email_history in a second request. Workshop
-- staff can update delivery notes but not write e-mail history, so their attempt left emailed_at set with no history;
-- and copying the e-mail text also stamped emailed_at although nothing was sent.
-- Now public.log_delivery_note_email() does both in one transaction, as the caller (row rules still apply):
--   * 'copied': history only; the note isn't marked as e-mailed;
--   * 'sent_manually' (staff confirmed they sent it): history with sent_at, and emailed_at on the note.
-- Admin and office only, as for e-mail history. Forward only, safe to run more than once.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION public.log_delivery_note_email(p_note UUID, p_to TEXT, p_subject TEXT, p_body TEXT, p_status TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office staff can record delivery note e-mails' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('copied', 'sent_manually') THEN
    RAISE EXCEPTION 'Unknown e-mail status' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(coalesce(p_to, '')), '') IS NULL THEN
    RAISE EXCEPTION 'There''s no email address for this customer. Add one on the Customers page first.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_notes WHERE id = p_note AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Delivery note not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, subject, body, status, related_to_type, related_to_id, drafted_by, sent_at)
  VALUES (v_org, btrim(p_to), p_subject, p_body, p_status, 'delivery_note', p_note::TEXT, auth.uid(),
          CASE WHEN p_status = 'sent_manually' THEN v_now END);
  IF p_status = 'sent_manually' THEN
    UPDATE public.delivery_notes SET emailed_at = v_now WHERE id = p_note AND organization_id = v_org;
    RETURN v_now;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.log_delivery_note_email(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_delivery_note_email(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
