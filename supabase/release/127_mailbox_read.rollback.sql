-- 127 rollback: ONLY with Rhys's approval. Removes inbox reading through the delegated connection: the five functions 127 created and
-- public.integration_mailbox_sync (each company's cursor and last-check status). Nothing else is touched: the inbox e-mails and RFQs
-- already stored stay (031's tables), every Microsoft 365 connection stays connected and keeps sending, and 031's record_inbound_email
-- and the legacy app-only path are unchanged. The app then reads no inbox through the delegated connection (127 missing reads as "off").
-- A connection's consent to Mail.Read stays at Microsoft until an admin disconnects there. Run the whole text as one transaction, then the
-- release preflight (marker 127 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  -- Each function must be 127's own (md5 with every whitespace character removed), or already gone.
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM (VALUES ('public.mailbox_sync_connected(uuid,text,boolean)', '157bc48f606d2d36a18cdcef5da067a5'),
               ('public.mailbox_sync_due(uuid)', 'f166b13165a5e3f45a8ee96ed9563ab2'),
               ('public.mailbox_sync_result(uuid,text,text,timestamp with time zone)', 'bc91232dd7936719831735c19703274c'),
               ('public.mailbox_record_inbound(uuid,text,text,text,text,text,timestamp with time zone,text,text)', '4a7ede00d54804941fc17a291bde6b4c'),
               ('public.mailbox_sync_status()', '2d190567cfe9f2bd8fa6c6d055b7df45')) AS f(sig, body)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
  WHERE md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> f.body;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '127 rollback: % not 127''s body; stop and compare', v_bad;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.mailbox_sync_status();
DROP FUNCTION IF EXISTS public.mailbox_record_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.mailbox_sync_result(UUID, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.mailbox_sync_due(UUID);
DROP FUNCTION IF EXISTS public.mailbox_sync_connected(UUID, TEXT, BOOLEAN);
DROP TABLE IF EXISTS public.integration_mailbox_sync;

DO $$
BEGIN
  IF to_regclass('public.integration_mailbox_sync') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                                                            WHERE n.nspname = 'public' AND p.proname LIKE 'mailbox\_sync\_%' OR (n.nspname = 'public' AND p.proname = 'mailbox_record_inbound')) THEN
    RAISE EXCEPTION '127 rollback self-check: something of 127 is still there';
  END IF;
  IF to_regprocedure('public.record_inbound_email(text,text,text,text,text,timestamp with time zone,text,text)') IS NULL THEN
    RAISE EXCEPTION '127 rollback self-check: 031''s record_inbound_email is missing';
  END IF;
END
$$;
COMMIT;
