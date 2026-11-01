-- 109_user_date_format.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 109: The date format as a per-person setting (Rhys, Wed 21 Oct 2026): each login chooses the order (DD/MM/YYYY, MM/DD/YYYY or
-- the ISO YYYY-MM-DD) and how the month is shown (number 10, short Oct, full October). The app formats every date on screen and on
-- what that person prints with it (lib/dates.ts); spreadsheet exports and the database are unchanged. App-side only otherwise.
--
-- WHAT CHANGES. One new table, public.user_preferences: one row per login (user_id, the auth user), with one checked column,
-- date_format, one of nine values '<order>-<month>' (order dmy / mdy / ymd, month number / short / full; default 'dmy-number',
-- DD/MM/YYYY, what the app showed before 109). No row means the default. Nothing else changes: no function, no other table.
-- RLS: OWN ROW ONLY. A signed-in person reads, adds and changes only the row whose user_id is their own (auth.uid()); nobody else,
-- company admins included, can read or change it (it lives in its own table, not user_profiles, because 007's "Admins read org
-- members" / "Admins update org members" policies let a company admin read and change a member's profile row). No DELETE (the app
-- writes the default instead), no API access for anon. Deleting the login deletes the row (ON DELETE CASCADE).
-- Not audited and no support read-only or admin two-step guard: a display choice that affects only the person who makes it, holds
-- no company data and grants nothing (the two-step guard covers what an admin does with money, documents, settings, people, mail).
-- GUARD (section 1): a public.user_preferences that is not 109's (other columns) stops the release and nothing of 109 is kept.
-- Safe to run again. Rollback: supabase/release/109_user_date_format.rollback.sql (drops the table; everyone sees DD/MM/YYYY again).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: a table of this name must be 109's (a second run) or absent.
DO $$
BEGIN
  IF to_regclass('public.user_preferences') IS NOT NULL
     AND (SELECT array_agg(column_name::TEXT ORDER BY column_name) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'user_preferences') IS DISTINCT FROM ARRAY['date_format', 'user_id'] THEN
    RAISE EXCEPTION '109: public.user_preferences already exists and is not 109''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The setting: one row per login, one checked column.
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  date_format TEXT NOT NULL DEFAULT 'dmy-number'
);
ALTER TABLE public.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_date_format_check;
ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_date_format_check CHECK (date_format IN (
  'dmy-number', 'dmy-short', 'dmy-full', 'mdy-number', 'mdy-short', 'mdy-full', 'ymd-number', 'ymd-short', 'ymd-full'));
COMMENT ON TABLE public.user_preferences IS
  '109: a login''s own display settings (date_format: <order>-<month>, default dmy-number = DD/MM/YYYY). RLS: own row only.';

-- -----------------------------------------------------------------------------------------------------
-- 3. Own row only: one policy per command (no FOR ALL), signed-in sessions only; no DELETE; nothing for anon.
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_preferences own select" ON public.user_preferences;
DROP POLICY IF EXISTS "user_preferences own insert" ON public.user_preferences;
DROP POLICY IF EXISTS "user_preferences own update" ON public.user_preferences;
CREATE POLICY "user_preferences own select" ON public.user_preferences FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "user_preferences own insert" ON public.user_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "user_preferences own update" ON public.user_preferences FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.user_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_preferences TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check before COMMIT: anything unexpected stops the release and nothing of 109 is kept.
DO $$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.user_preferences'::regclass) THEN
    RAISE EXCEPTION '109: user_preferences has RLS off';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences') <> 3
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences'
                AND (cmd NOT IN ('SELECT', 'INSERT', 'UPDATE') OR permissive <> 'PERMISSIVE' OR roles <> ARRAY['authenticated']::NAME[]
                     OR coalesce(qual, '(user_id = ( SELECT auth.uid() AS uid))') <> '(user_id = ( SELECT auth.uid() AS uid))'
                     OR coalesce(with_check, '(user_id = ( SELECT auth.uid() AS uid))') <> '(user_id = ( SELECT auth.uid() AS uid))')) THEN
    RAISE EXCEPTION '109: user_preferences policies are not own-row only';
  END IF;
  IF has_table_privilege('authenticated', 'public.user_preferences', 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.user_preferences', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.user_preferences', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.user_preferences', 'UPDATE')
     OR has_table_privilege('anon', 'public.user_preferences', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '109: user_preferences grants are not SELECT, INSERT, UPDATE for signed-in users only';
  END IF;
END
$$;

COMMIT;
