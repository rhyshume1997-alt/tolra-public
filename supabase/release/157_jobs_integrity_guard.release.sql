-- Post-144 release step 157 (jobs integrity guard: a recorded start time is kept, a finish time is set only by Finish, a workshop-only user can't change a
-- job's customer or number or withdraw a passed inspection, and nobody ordinary-edits away the passed inspection of a despatched or invoiced job; registered in supabase/release-plan.json as phase 157, after 156; 155 is reserved and not
-- in this candidate; CI's post-144 step installs it). One transaction; never part of baseline replay. Not applied anywhere hosted: migration allowed
-- for development, scratch and CI only (PM, 15 Nov 2026); production only with Rhys's separate yes. Canonical source:
-- supabase/proposals/p157_jobs_integrity_guard.sql (its body between BEGIN; and COMMIT; is copied below verbatim between the fingerprint and the
-- self-check; read its header). Its guard needs the job objects of 022, 034, 035, 037, 044/061, 081, 083 and 113 only, not 156.
-- Verify: supabase/verify/jobs_integrity_guard_157.sql (every row true).
-- Rollback: supabase/release/157_jobs_integrity_guard.rollback.sql (drops the trigger and the function; touches no row). Running this file again once
-- applied changes nothing (the function is 157's, the trigger exists and is not created again).
-- REFUSES, changing nothing, when a job object it relies on is missing or is not as the older releases left it (HINT jobs_integrity_prerequisite), or
-- when a function or trigger already named jobs_integrity_guard / jobs_zzz_integrity_guard is not 157's (HINT jobs_integrity_name_taken).
-- Changes no row, no existing function, trigger, grant or policy (the one function it replaces is its own, jobs_integrity_guard): a before/after fingerprint of the jobs triggers, policies and grants and of every
-- other function in public must be identical, or the self-check stops the release.
-- BEHAVIOUR CHANGE (workshop users): editing the worksheet, stage, customer or job number of a job that has passed inspection is refused. Re-inspection,
-- rework and reopen are unchanged (docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md, L12).
-- BEHAVIOUR CHANGE (every browser role, office and admin too; rule C5, HINT released_pass_kept): once a job is despatched or invoiced, an ordinary edit that
-- would withdraw its passed inspection is refused. A correction goes through a failed inspection or rework (which record a reason), never a worksheet edit.
-- DEFINER RIGHTS (reviewed explicitly): public.jobs_integrity_guard() is SECURITY DEFINER with search_path = pg_catalog, public, following 044's
-- jobs_finish_guard, so C5 can see delivery notes and invoices whatever the caller may read (an Invoices-hidden office or admin member would otherwise
-- pass an invoker lookup). Its lookups are two EXISTS tests pinned to the job's own company and the job's own id / number and return only yes or no;
-- the refusal text is fixed and quotes no document number. EXECUTE stays revoked from PUBLIC, anon and authenticated (a trigger function needs none to
-- fire); service_role is left as 044 leaves it. See the comment at the top of the function body.
BEGIN;
DO $post_release_guard$
DECLARE
  v         TEXT;
  v_missing TEXT;
BEGIN
 SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO v_missing FROM (
   SELECT 'trigger ' || r.tg AS what FROM unnest(ARRAY['jobs_worksheet_version', 'jobs_worksheet_version_release', 'jobs_zz_drawing_revision', 'zzz_actor_stamp',
                                                      'ad_finish_kept', 'ac_finish_guard', 'jobs_rework_stage_guard']) AS r(tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = r.tg AND NOT t.tgisinternal)
   UNION ALL
   SELECT 'function ' || f.fn || ' naming ' || f.flag FROM (VALUES
     ('finish_job', 'tolra.finish_job'), ('reopen_job', 'quoteflow.job_reopen'), ('_reopen_job_signed_off', 'quoteflow.job_reopen'),
     ('record_job_inspection', 'quoteflow.job_inspection'), ('fail_job_inspection', 'quoteflow.job_inspection'),
     ('open_replacement_rework', 'quoteflow.job_rework'), ('finish_job_rework', 'quoteflow.job_rework')) AS f(fn, flag)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.fn AND position(f.flag IN p.prosrc) > 0)
   UNION ALL
   SELECT 'function has_org_role(text[])' WHERE to_regprocedure('public.has_org_role(text[])') IS NULL
 ) m;
 IF v_missing IS NOT NULL THEN
  RAISE EXCEPTION '157: required job objects are missing or are not as releases 022 to 113 left them (%); stop and check release preflight', v_missing
    USING HINT = 'jobs_integrity_prerequisite';
 END IF;
 IF to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()');
  IF v IS DISTINCT FROM '9b48981a3e865e1d0788e017237c7fca' THEN
   RAISE EXCEPTION '157: a function public.jobs_integrity_guard() exists and is not 157''s; stop and compare it first' USING HINT = 'jobs_integrity_name_taken';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal)
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 19 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                      AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
  RAISE EXCEPTION '157: a trigger named jobs_zzz_integrity_guard exists on public.jobs and is not 157''s; stop and compare it first' USING HINT = 'jobs_integrity_name_taken';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything on jobs and in public that 157 must not touch (the other triggers on jobs, its policies, its grants and row
-- security, and every other function in public: body, definer flag, grants, settings). The self-check requires the identical fingerprint.
-- Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p157_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p157fp$
  SELECT 'jobs triggers'::TEXT, md5(coalesce(string_agg(t.tgname || ' ' || pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::TEXT, E'\n' ORDER BY t.tgname COLLATE "C"), ''))
  FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND NOT t.tgisinternal AND t.tgname <> 'jobs_zzz_integrity_guard'
  UNION ALL SELECT 'jobs policies', md5(coalesce(string_agg(p.polname::TEXT || ' ' || p.polcmd::TEXT || ' ' || p.polpermissive::TEXT || ' ' || p.polroles::TEXT || ' '
                                                           || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\n' ORDER BY p.polname COLLATE "C"), ''))
  FROM pg_policy p WHERE p.polrelid = 'public.jobs'::regclass
  UNION ALL SELECT 'jobs grants and row security', md5(coalesce((SELECT c.relacl::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass), '') || '|'
                                                    || (SELECT c.relrowsecurity::TEXT || c.relforcerowsecurity::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass) || '|'
                                                    || coalesce((SELECT string_agg(a.attname::TEXT || ':' || a.attacl::TEXT, ',' ORDER BY a.attname COLLATE "C") FROM pg_attribute a
                                                                 WHERE a.attrelid = 'public.jobs'::regclass AND a.attacl IS NOT NULL), ''))
  UNION ALL SELECT 'public functions', md5(coalesce(string_agg(p.oid::regprocedure::TEXT || ' ' || md5(p.prosrc) || ' ' || p.prosecdef::TEXT || ' ' || coalesce(p.proacl::TEXT, '') || ' '
                                                              || coalesce(p.proconfig::TEXT, ''), E'\n' ORDER BY p.oid::regprocedure::TEXT COLLATE "C"), ''))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'jobs_integrity_guard'
$p157fp$;
CREATE TEMP TABLE p157_before ON COMMIT DROP AS SELECT * FROM pg_temp.p157_fingerprint();

-- ---- 1. The trigger function and the trigger (the canonical body, verbatim) ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.jobs_integrity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job       BOOLEAN := FALSE;
  v_withdraws BOOLEAN;
BEGIN
  -- 157 jobs_integrity_guard (marker; the release guard and the verify script recognise this body by it and by its checksum).
  -- SECURITY DEFINER, on the 044 precedent (public.jobs_finish_guard), for ONE reason: rule C5 must see the job's delivery notes and invoices
  -- whatever the caller may read. An office or admin member whose Invoices section is hidden is refused every invoices row by the RESTRICTIVE policy
  -- "invoices section access" (012, section_allowed('invoices')), so an invoker lookup would find nothing and C5 would fail open for exactly that person.
  -- What the definer rights are used for, and nothing else: the two EXISTS tests in C5, each pinned to organization_id = OLD.organization_id and to this
  -- job (its id; its job_no for a delivery note linked by reference only), answering the trigger only yes or no. No row, name or number is read out,
  -- returned, logged or put in a message. The error text is fixed: it quotes no delivery-note or invoice number, so a person who may not see invoices
  -- learns only that the job has gone out or been invoiced (reopen_job's message, which quotes them, is deliberately not copied).
  -- The function reads and writes nothing else, takes no argument, calls no dynamic SQL, and is a trigger function only: EXECUTE is revoked from PUBLIC,
  -- anon and authenticated below, so it is not callable from the browser. Every table and function is schema-qualified; the search_path is pinned.
  -- Who is a browser session is decided as in 044's definer jobs_finish_guard: current_setting('role') is the request role PostgREST sets for the
  -- request and SECURITY DEFINER does not change it (only current_user changes), and session_user is the login role; so the exemption below still
  -- identifies anon / authenticated sessions here, and the service role, the owner, the SQL editor and imports stay exempt.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- C1: a recorded start is kept; the first Start (from empty) is allowed.
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'Job %: its start time is kept as it was recorded and can''t be changed or cleared.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'start_kept';
  END IF;
  -- C4: a finish time is set only by finish_job, which names itself in tolra.finish_job for its own statement.
  IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND coalesce(current_setting('tolra.finish_job', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'Job %: finish it from the Job Board (Finish); the finish time can''t be set by editing the job.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'finish_via_rpc';
  END IF;
  -- Does this update withdraw a passed inspection? Worked out once. (034's jobs_worksheet_version_release has already turned a worksheet edit of an
  -- inspected job into inspected_at NULL and stage 'inspection', so a worksheet edit shows up here as one of these two.)
  v_withdraws := (OLD.inspected_at IS NOT NULL AND NEW.inspected_at IS NULL) OR (OLD.stage = 'complete' AND NEW.stage IS DISTINCT FROM 'complete');
  IF v_withdraws THEN
    -- An authorised workflow names this job: record_job_inspection, fail_job_inspection, open_replacement_rework, finish_job_rework (quoteflow.job_inspection),
    -- rework (quoteflow.job_rework) or reopen (quoteflow.job_reopen). It then withdraws the pass for every role, with its own reason recorded; neither C5 nor C2 applies.
    v_job := current_setting('quoteflow.job_inspection', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
          OR current_setting('quoteflow.job_rework', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
          OR current_setting('quoteflow.job_reopen', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
    -- C5, every browser role (office and admin included): once the job has gone out or been invoiced, an ordinary edit can't withdraw its passed inspection.
    -- Same tests as reopen_job (081, 113), copied faithfully, scoped to this company and this job with the definer's rights (see the top of this function):
    -- a delivery note of this company that is despatched, delivered or signed, linked by job_id or (job_id empty) by the job number; or an invoice of this
    -- company for this job that is not draft, void, voided, cancelled or canceled.
    IF NOT v_job AND (
         EXISTS (SELECT 1 FROM public.delivery_notes d
                 WHERE d.organization_id = OLD.organization_id AND d.status IN ('despatched', 'delivered', 'signed')
                   AND (d.job_id = OLD.id OR (d.job_id IS NULL AND nullif(btrim(d.job_ref), '') = OLD.job_no)))
         OR EXISTS (SELECT 1 FROM public.invoices i
                    WHERE i.job_id = OLD.id AND i.organization_id = OLD.organization_id
                      AND lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled'))) THEN
      RAISE EXCEPTION 'Job %: it has been despatched or invoiced, so its passed inspection stands. If something is wrong with it, record a failed inspection or raise rework.', OLD.job_no
        USING ERRCODE = '42501', HINT = 'released_pass_kept';
    END IF;
  END IF;
  -- C3 and C2 concern a workshop-only user (admin and office are unchanged by them). The role lookup runs only when one of them applies.
  -- has_org_role is itself SECURITY DEFINER (036) and answers from auth.uid() and the request's JWT claims, so it names the CALLER whether or not this function is definer.
  IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no OR v_withdraws THEN
    IF public.has_org_role(ARRAY['workshop']) AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
      IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no THEN
        RAISE EXCEPTION 'Job %: only admin and office staff change a job''s customer or job number.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'job_identity_office';
      END IF;
      IF v_withdraws AND NOT v_job THEN
        RAISE EXCEPTION 'Job %: its passed inspection is withdrawn only by the office or an admin, or by recording a failed inspection, raising rework or reopening the job.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'inspection_kept';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- Grants (044 precedent: REVOKE ALL FROM PUBLIC, anon, authenticated; no GRANT). service_role is left as the platform default has it, as 044 leaves it
-- for jobs_finish_guard: a trigger function needs no EXECUTE privilege to fire (it is checked when the trigger is created, by the owner), and service_role
-- is exempt inside the body anyway; revoking it (as 156 does for its RPC helpers) is not needed to keep the browser out.
REVOKE ALL ON FUNCTION public.jobs_integrity_guard() FROM PUBLIC, anon, authenticated;

-- One trigger, created once (running this again changes nothing). Its name sorts after jobs_zz_drawing_revision and before zzz_actor_stamp.
DO $p157_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal) THEN
    CREATE TRIGGER jobs_zzz_integrity_guard BEFORE UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.jobs_integrity_guard();
  END IF;
END
$p157_trigger$;

DO $p157_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '9b48981a3e865e1d0788e017237c7fca'
                   AND p.prorettype = 'trigger'::regtype AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION '157 self-check: public.jobs_integrity_guard() must be 157''s trigger function, SECURITY DEFINER (as 044''s jobs_finish_guard), with its search_path pinned';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
    RAISE EXCEPTION '157 self-check: public.jobs_integrity_guard() must be callable by no API role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                   AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 19 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                   AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
    RAISE EXCEPTION '157 self-check: jobs_zzz_integrity_guard must be the BEFORE UPDATE row trigger (no column list) running public.jobs_integrity_guard()';
  END IF;
  -- It runs after 022, 034 and 083's triggers and before 035's actor stamp (BEFORE row triggers fire in byte order of their names).
  IF NOT ('jobs_worksheet_version' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_worksheet_version_release' COLLATE "C" < 'jobs_zzz_integrity_guard'
          AND 'jobs_zz_drawing_revision' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_zzz_integrity_guard' COLLATE "C" < 'zzz_actor_stamp') THEN
    RAISE EXCEPTION '157 self-check: the trigger name must sort after the 022, 034 and 083 job triggers and before zzz_actor_stamp';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_before EXCEPT SELECT * FROM pg_temp.p157_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p157_fingerprint() EXCEPT SELECT * FROM pg_temp.p157_before) THEN
    RAISE EXCEPTION '157 self-check: another trigger, policy or grant on jobs, or another function in public, changed';
  END IF;
END
$p157_self_check$;
DROP TABLE pg_temp.p157_before;
DROP FUNCTION pg_temp.p157_fingerprint();
COMMIT;
