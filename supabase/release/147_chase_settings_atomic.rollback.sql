-- REVIEW ONLY. Stop the settings client before removing its RPC. Never fall back to partial saves.
-- Removes the reviewed function only. No settings, chase history or audit row is changed.
BEGIN;
DO $rollback_guard$
BEGIN
 IF (SELECT md5(regexp_replace(prosrc,'\s','','g'))='63145f3026fdc7db5dc1ba0a5928177a' AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid=to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)')) IS DISTINCT FROM true THEN
  RAISE EXCEPTION '147 rollback: function absent or differs; stop and review';
 END IF;
END; $rollback_guard$;
DROP FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb);
-- No CASCADE: unexpected dependent objects must refuse the whole transaction.
COMMIT;
