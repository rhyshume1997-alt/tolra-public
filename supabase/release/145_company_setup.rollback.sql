-- Post-144 rollback: review retained history and settle reservations first.
-- Review first: removes setup ticks only; company details, users and records are kept.
-- It REFUSES while any setup tick row exists, unless the runner first says, in the same session, that deleting them is accepted:
--     SET tolra.x145_accept_deleting_setup_ticks = 'yes';
BEGIN;
DO $rb$ BEGIN
 IF to_regclass('public.company_setup_progress') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM public.company_setup_progress) AND coalesce(current_setting('tolra.x145_accept_deleting_setup_ticks', TRUE), '') <> 'yes' THEN
   RAISE EXCEPTION '145 rollback refused: setup ticks exist; rolling back deletes them. SET tolra.x145_accept_deleting_setup_ticks = ''yes'' first if that is accepted.';
  END IF;
 END IF;
END $rb$;
DROP TABLE public.company_setup_progress;
COMMIT;
