-- =====================================================================================================
-- 029: job inspection step.
--
-- Finishing a job puts it at the inspection stage ("awaiting inspection"); a person then marks it inspected, which
-- records when and by whom and moves the job to done. The app sets these together with stage = 'complete'.
-- Writes go through the existing jobs policies (admin, office, workshop). Forward only, safe to run more than once.
-- =====================================================================================================

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS inspected_by TEXT;
