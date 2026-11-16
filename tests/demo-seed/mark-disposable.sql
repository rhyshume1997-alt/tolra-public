-- OPERATOR/CI PREPARATION ONLY. Never called by the seed. Not run in this PR.
-- Fresh disposable backend only. A new per-run UUID must be supplied as disposable_id.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN
 IF current_user <> 'postgres' OR EXISTS (SELECT 1 FROM public.organizations) THEN
  RAISE EXCEPTION 'Refusing marker: requires postgres and an empty disposable database';
 END IF;
END $guard$;
CREATE SCHEMA demo_seed_guard;
REVOKE ALL ON SCHEMA demo_seed_guard FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE demo_seed_guard.identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 disposable_id uuid NOT NULL,
 database_name text NOT NULL,
 expires_at timestamptz NOT NULL
);
REVOKE ALL ON demo_seed_guard.identity FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO demo_seed_guard.identity VALUES (true, :'disposable_id'::uuid, current_database(), clock_timestamp() + interval '15 minutes');
COMMIT;
