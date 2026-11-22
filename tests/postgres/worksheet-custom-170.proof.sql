-- Release 170 behavioural proof on a plain PostgreSQL stand-in (run by hand: psql -v ON_ERROR_STOP=1 -f tests/postgres/worksheet-custom-170.proof.sql
-- against an EMPTY scratch database; it DROPS and recreates schema public, so never point it at a real database). Not run by CI (CI has no
-- plain-PG step for this); the Supabase-stack proof is a later numbered-phase task. It builds a tiny stand-in for public.jobs and
-- public.job_signoffs, applies supabase/release/170_worksheet_custom.release.sql (twice), and checks: every existing job gets {}, a browser session can fill
-- the fields of an unsigned job, cannot change a job whose CURRENT revision has a primary sign-off (42501, hint signed_off_custom_locked), can
-- again after a newer revision, the owner is exempt, no other column changes, bad shapes are refused, and the rollback restores the table.
-- Inputs: none. Outputs: psql stops with an error if any check fails, else prints PASS lines. Must not change: it never touches real data.
\set ON_ERROR_STOP on
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_no text, worksheet_version integer NOT NULL DEFAULT 0, description text, checklist jsonb);
CREATE TABLE public.job_signoffs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id), worksheet_version integer NOT NULL, kind text NOT NULL);
GRANT USAGE ON SCHEMA public TO anon, authenticated; GRANT SELECT, UPDATE, INSERT ON public.jobs TO authenticated; GRANT SELECT ON public.job_signoffs TO authenticated;
INSERT INTO public.jobs (job_no, worksheet_version, description, checklist) SELECT 'J-' || g, 2, 'd' || g, '{"sizes_checked":true}' FROM generate_series(1, 3) g;
CREATE TEMP TABLE before_rows AS SELECT to_jsonb(j) AS r FROM public.jobs j;

\i supabase/release/170_worksheet_custom.release.sql
-- Running the release a second time changes nothing (INSTALLED), and the verify script prints 8 rows, all t (read them: psql cannot assert on a file's output).
\i supabase/release/170_worksheet_custom.release.sql
\i supabase/verify/worksheet_custom_170.sql

DO $$ BEGIN
  IF (SELECT count(*) FILTER (WHERE worksheet_custom = '{}'::jsonb) FROM public.jobs) <> 3 THEN RAISE EXCEPTION 'FAIL every existing job gets {}'; END IF;
  IF EXISTS (SELECT 1 FROM before_rows b JOIN public.jobs j ON (b.r->>'id')::uuid = j.id WHERE (to_jsonb(j) - 'worksheet_custom') IS DISTINCT FROM b.r) THEN RAISE EXCEPTION 'FAIL an existing column changed'; END IF;
  RAISE NOTICE 'PASS existing job data is unchanged and every job has {}';
END $$;

-- 1. A browser session fills the fields of an unsigned job.
SET ROLE authenticated;
UPDATE public.jobs SET worksheet_custom = '{"v":1,"ticks":{"a":true},"texts":{"t":"hello"}}' WHERE job_no = 'J-1';
RESET ROLE;
DO $$ BEGIN IF (SELECT worksheet_custom->'texts'->>'t' FROM public.jobs WHERE job_no = 'J-1') <> 'hello' THEN RAISE EXCEPTION 'FAIL unsigned job editable'; END IF; RAISE NOTICE 'PASS an unsigned job can be filled in'; END $$;

-- 2. A primary sign-off on the CURRENT revision locks it for browser sessions (and only the custom column).
INSERT INTO public.job_signoffs (job_id, worksheet_version, kind) SELECT id, worksheet_version, 'primary' FROM public.jobs WHERE job_no = 'J-1';
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN
    UPDATE public.jobs SET worksheet_custom = '{"v":1,"ticks":{"a":false},"texts":{}}' WHERE job_no = 'J-1';
    RAISE EXCEPTION 'FAIL signed-off job was changed';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%signed off%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS a signed-off worksheet cannot change (42501)';
  END;
  UPDATE public.jobs SET worksheet_custom = worksheet_custom WHERE job_no = 'J-1'; -- an unchanged value is not a change
  RAISE NOTICE 'PASS writing the same value back is allowed';
END $$;
RESET ROLE;

-- 3. The owner / SQL editor / service role are exempt.
UPDATE public.jobs SET worksheet_custom = '{"v":1,"ticks":{},"texts":{"t":"owner"}}' WHERE job_no = 'J-1';
-- 4. After a newer revision (edited since the sign-off) the old sign-off no longer locks it.
UPDATE public.jobs SET worksheet_version = 3 WHERE job_no = 'J-1';
SET ROLE authenticated;
UPDATE public.jobs SET worksheet_custom = '{"v":1,"ticks":{"a":true},"texts":{}}' WHERE job_no = 'J-1';
-- 5. Another job with no sign-off is untouched by J-1's.
UPDATE public.jobs SET worksheet_custom = '{"v":1,"ticks":{"b":true},"texts":{}}' WHERE job_no = 'J-2';
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS owner exempt; a newer revision unlocks; other jobs unaffected'; END $$;

-- 6. Bad shapes are refused by the table.
DO $$ BEGIN
  BEGIN UPDATE public.jobs SET worksheet_custom = '[]'::jsonb WHERE job_no = 'J-3'; RAISE EXCEPTION 'FAIL array accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.jobs SET worksheet_custom = jsonb_build_object('t', repeat('x', 21000)) WHERE job_no = 'J-3'; RAISE EXCEPTION 'FAIL oversize accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.jobs SET worksheet_custom = NULL WHERE job_no = 'J-3'; RAISE EXCEPTION 'FAIL null accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;
  RAISE NOTICE 'PASS an array, an oversize value and NULL are refused';
END $$;

-- 7. The trigger function cannot be called by browser roles.
DO $$ BEGIN
  IF has_function_privilege('authenticated', 'public.jobs_worksheet_custom_lock()', 'EXECUTE') OR has_function_privilege('anon', 'public.jobs_worksheet_custom_lock()', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL browser roles can execute the function'; END IF;
  RAISE NOTICE 'PASS no browser role can execute the trigger function';
END $$;

-- 8. Rollback restores the table exactly (column, constraint, trigger and function gone).
\i supabase/release/170_worksheet_custom.rollback.sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'worksheet_custom') THEN RAISE EXCEPTION 'FAIL column remains'; END IF;
  IF to_regprocedure('public.jobs_worksheet_custom_lock()') IS NOT NULL THEN RAISE EXCEPTION 'FAIL function remains'; END IF;
  IF EXISTS (SELECT 1 FROM before_rows b JOIN public.jobs j ON (b.r->>'id')::uuid = j.id WHERE to_jsonb(j) IS DISTINCT FROM b.r AND j.job_no <> 'J-1') THEN RAISE EXCEPTION 'FAIL rollback changed job data'; END IF;
  RAISE NOTICE 'PASS rollback leaves the jobs table as it was before 170';
END $$;
