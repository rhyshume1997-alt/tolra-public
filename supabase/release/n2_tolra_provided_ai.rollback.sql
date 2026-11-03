-- REVIEW ONLY; NOT APPLIED. Restore original own-key functions and grants.
-- Turn Tolra AI off and settle outstanding provided requests first. Usage,
-- request history and its key_source column are deliberately retained.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.ai_helper_requests WHERE key_source = 'tolra' AND status = 'reserved') THEN
  RAISE EXCEPTION 'Settle outstanding Tolra requests before rollback.';
 END IF;
END $$;
-- Do not silently send with an own key after rollback: turn off features for
-- companies that had selected Tolra. Their admins can choose own-key AI later.
UPDATE public.ai_helper_settings s SET roundup_enabled = FALSE, rfq_enabled = FALSE, assistant_enabled = FALSE
FROM public.ai_helper_tolra_companies c WHERE c.organization_id = s.organization_id AND c.enabled;
DROP FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER);
DROP FUNCTION public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER);
DROP FUNCTION public.ai_helper_status();
DROP FUNCTION public.ai_helper_set_tolra_mode(BOOLEAN);
DROP FUNCTION public.ai_helper_tolra_key(UUID,UUID);
DROP FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID);
DROP FUNCTION public.ai_helper_tolra_owner_status();
DROP FUNCTION public._ai_helper_reserve_tolra(TEXT,INTEGER,TEXT,INTEGER);
ALTER FUNCTION public._ai_helper_reserve_own_key(TEXT,INTEGER,TEXT,INTEGER) RENAME TO ai_helper_reserve;
ALTER FUNCTION public._ai_helper_reserve_assistant_own_key(INTEGER,TEXT,INTEGER) RENAME TO ai_helper_reserve_assistant;
ALTER FUNCTION public._ai_helper_status_own_key() RENAME TO ai_helper_status;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER), public.ai_helper_status() TO authenticated;
DROP TABLE public.ai_helper_tolra_companies;
DROP TABLE public.ai_helper_tolra_control;
COMMIT;
