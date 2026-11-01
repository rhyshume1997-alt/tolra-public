-- 125 rollback: ONLY with Rhys's approval. Drops public.link_inbound_email, the two same-company triggers, the link rules and indexes, and
-- the five columns 125 added to public.inbound_emails: every link and every suggestion is lost (a NOTICE says how many). The e-mails
-- themselves, their RFQs, and any customer PO that a Link wrote onto a quote through 123 stay as they are; the audit rows
-- (SUGGEST_EMAIL_LINK, LINK_INBOUND_EMAIL, SET_CUSTOMER_PO) stay. Nothing else is touched. Run the whole text as one transaction, then the
-- release preflight (marker 125 shows "not applied") and supabase/verify/catalogue.sql (it matches the catalogue of 000 to 124 again).
BEGIN;
DO $$
DECLARE
  v_md5   TEXT;
  v_links BIGINT := 0;
  v_sugg  BIGINT := 0;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)') INTO v_md5;
  -- 2f7a1169a7087cf17a3f872a8f08a088: 125's body; NULL: already rolled back (a second run).
  IF v_md5 IS NOT NULL AND v_md5 <> '2f7a1169a7087cf17a3f872a8f08a088' THEN
    RAISE EXCEPTION '125 rollback: link_inbound_email (md5 %) is not 125''s; stop and compare', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inbound_emails' AND column_name = 'link_status') THEN
    EXECUTE 'SELECT count(*) FILTER (WHERE linked_quote_id IS NOT NULL OR linked_purchase_order_id IS NOT NULL),
                    count(*) FILTER (WHERE jsonb_array_length(link_suggestions) > 0) FROM public.inbound_emails' INTO v_links, v_sugg;
  END IF;
  RAISE NOTICE '125 rollback: % linked e-mail(s) and % e-mail(s) with suggestions lose them', v_links, v_sugg;
END
$$;

DROP FUNCTION IF EXISTS public.link_inbound_email(UUID, TEXT, UUID, TEXT, TEXT);
DROP TRIGGER IF EXISTS zz_same_org_linked_quote_id ON public.inbound_emails;
DROP TRIGGER IF EXISTS zz_same_org_linked_purchase_order_id ON public.inbound_emails;
DROP INDEX IF EXISTS public.idx_inbound_emails_linked_quote;
DROP INDEX IF EXISTS public.idx_inbound_emails_linked_po;
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_link_status_check;
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_one_link_check;
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_linked_by_check;
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_linked_po_check;
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_link_suggestions_check;
ALTER TABLE public.inbound_emails DROP COLUMN IF EXISTS linked_quote_id;
ALTER TABLE public.inbound_emails DROP COLUMN IF EXISTS linked_purchase_order_id;
ALTER TABLE public.inbound_emails DROP COLUMN IF EXISTS link_status;
ALTER TABLE public.inbound_emails DROP COLUMN IF EXISTS linked_po_number;
ALTER TABLE public.inbound_emails DROP COLUMN IF EXISTS link_suggestions;

DO $$
BEGIN
  IF to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inbound_emails'
                  AND column_name IN ('linked_quote_id', 'linked_purchase_order_id', 'link_status', 'linked_po_number', 'link_suggestions'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.inbound_emails'::regclass AND tgname LIKE 'zz_same_org_linked_%') THEN
    RAISE EXCEPTION '125 rollback: something of 125 is still there';
  END IF;
END
$$;
COMMIT;
