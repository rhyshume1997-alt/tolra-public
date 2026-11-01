-- 133 rollback: ONLY with Rhys's approval. Drops public.ai_helper_reserve_assistant(integer, text, integer),
-- public.ai_helper_set_assistant(boolean) and ai_helper_settings.assistant_enabled, and restores 101's two-feature CHECK on
-- ai_helper_requests. No existing function is touched (133 replaced none: ai_helper_reserve stays 103's, settle 103's, decide 101's,
-- status 122's). STOPS, changing nothing, if any assistant request row exists (the two-feature CHECK could not hold): Rhys decides what
-- happens to those rows first (their audit events stay either way). Run the whole text as one transaction, then the release preflight
-- (marker 133 shows "not applied"). The app keeps working after it: the assistant reads as not available.
BEGIN;
DO $$
DECLARE
  v_rows BIGINT;
BEGIN
  SELECT count(*) FROM public.ai_helper_requests r WHERE r.feature = 'assistant' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION '133 rollback stopped: % assistant request row(s) exist; Rhys decides what happens to them before 133 is rolled back', v_rows;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.ai_helper_reserve_assistant(INTEGER, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.ai_helper_set_assistant(BOOLEAN);
ALTER TABLE public.ai_helper_settings DROP COLUMN IF EXISTS assistant_enabled;
ALTER TABLE public.ai_helper_requests DROP CONSTRAINT IF EXISTS ai_helper_requests_feature;
ALTER TABLE public.ai_helper_requests ADD CONSTRAINT ai_helper_requests_feature CHECK (feature IN ('roundup', 'rfq'));

DO $$
BEGIN
  IF to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)') IS NOT NULL
     OR to_regprocedure('public.ai_helper_set_assistant(boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'assistant_enabled') THEN
    RAISE EXCEPTION '133 rollback: the database is not back to the AI helper before 133';
  END IF;
END
$$;
COMMIT;
