-- Refuse teardown after first use. Roll forward to retain exact send links and recovery history.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'security_audit.company_email_sends'::regclass
    AND attname = 'approval_draft_id' AND NOT attisdropped) THEN
    LOCK TABLE security_audit.company_email_sends IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM security_audit.company_email_sends WHERE approval_draft_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback refused: linked send history exists. Roll forward instead.';
    END IF;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.approval_email_failed_drafts(uuid[]);
DROP FUNCTION IF EXISTS public.resolve_approval_email(uuid,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.reserve_approval_email(uuid,uuid,uuid,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.approval_email_attempt_status(uuid,uuid,uuid);
DROP INDEX IF EXISTS security_audit.company_email_approval_attempt;
ALTER TABLE security_audit.company_email_sends
  DROP COLUMN IF EXISTS approval_resolution, DROP COLUMN IF EXISTS approval_attempt, DROP COLUMN IF EXISTS approval_draft_id;
COMMIT;
