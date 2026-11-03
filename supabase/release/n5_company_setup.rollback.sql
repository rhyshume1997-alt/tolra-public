-- Review first: removes setup ticks only; company details, users and records are kept.
BEGIN;
DROP TABLE public.company_setup_progress;
COMMIT;
