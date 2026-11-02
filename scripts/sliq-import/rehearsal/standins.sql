-- Supabase stand-ins for a LOCAL plain PostgreSQL 16 (127.0.0.1:5432, user postgres). NOT Supabase: only the
-- roles, schemas, auth / storage tables and helper functions that supabase/migrations reference, shaped like
-- Supabase's own, so the chain applies with psql -1 -f and the catalogue (supabase/verify/catalogue.sql) compares.
-- Run as postgres into an EMPTY database. Re-runnable. Roles are cluster-wide and created only when missing.
-- No GoTrue / PostgREST / Storage API: anything that needs those (auth.admin.createUser, REST calls) is not covered.
\set ON_ERROR_STOP 1

-- 1. Roles ---------------------------------------------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r); END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN NOINHERIT;  -- PostgREST's login role on Supabase; NOLOGIN here (local, no password)
  END IF;
END
$$;
ALTER ROLE service_role BYPASSRLS;
GRANT anon, authenticated, service_role TO postgres;
GRANT anon, authenticated, service_role TO authenticator;

-- 2. Schemas, search_path, default privileges (as Supabase sets them for objects postgres creates in public) -----
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
GRANT USAGE ON SCHEMA public, extensions, auth, storage TO anon, authenticated, service_role;
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET search_path TO "$user", public, extensions', current_database()); END $$;
SET search_path TO "$user", public, extensions;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- Supabase pre-installs these in the extensions schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- 3. Migration tracking --------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT,
  statements  TEXT[],
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. auth: users, sessions, mfa_factors, uid() / jwt() / role() / email() ------------------------------------
DO $$ BEGIN
  IF to_regtype('auth.aal_level') IS NULL THEN CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3'); END IF;
  IF to_regtype('auth.factor_type') IS NULL THEN CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone'); END IF;
  IF to_regtype('auth.factor_status') IS NULL THEN CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified'); END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id                 UUID,
  id                          UUID PRIMARY KEY,
  aud                         VARCHAR(255),
  role                        VARCHAR(255),
  email                       VARCHAR(255),
  encrypted_password          VARCHAR(255),
  email_confirmed_at          TIMESTAMPTZ,
  invited_at                  TIMESTAMPTZ,
  confirmation_token          VARCHAR(255),
  confirmation_sent_at        TIMESTAMPTZ,
  recovery_token              VARCHAR(255),
  recovery_sent_at            TIMESTAMPTZ,
  email_change_token_new      VARCHAR(255),
  email_change                VARCHAR(255),
  email_change_sent_at        TIMESTAMPTZ,
  last_sign_in_at             TIMESTAMPTZ,
  raw_app_meta_data           JSONB,
  raw_user_meta_data          JSONB,
  is_super_admin              BOOLEAN,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now(),
  phone                       TEXT UNIQUE,
  phone_confirmed_at          TIMESTAMPTZ,
  phone_change                TEXT DEFAULT '',
  phone_change_token          VARCHAR(255) DEFAULT '',
  phone_change_sent_at        TIMESTAMPTZ,
  confirmed_at                TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  email_change_token_current  VARCHAR(255) DEFAULT '',
  email_change_confirm_status SMALLINT DEFAULT 0,
  banned_until                TIMESTAMPTZ,
  reauthentication_token      VARCHAR(255) DEFAULT '',
  reauthentication_sent_at    TIMESTAMPTZ,
  is_sso_user                 BOOLEAN NOT NULL DEFAULT false,
  deleted_at                  TIMESTAMPTZ,
  is_anonymous                BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS users_email_idx ON auth.users (email);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  factor_id    UUID,
  aal          auth.aal_level,
  not_after    TIMESTAMPTZ,
  refreshed_at TIMESTAMP,
  user_agent   TEXT,
  ip           INET,
  tag          TEXT
);

CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id                 UUID PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  friendly_name      TEXT,
  factor_type        auth.factor_type NOT NULL,
  status             auth.factor_status NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  secret             TEXT,
  phone              TEXT,
  last_challenged_at TIMESTAMPTZ
);

-- Same bodies as Supabase's helpers: the claim from request.jwt.claim.* (legacy) or request.jwt.claims (JSON).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email(), auth.jwt() TO anon, authenticated, service_role;

-- 5. storage: buckets, objects (RLS on, as Supabase), foldername / filename / extension ------------------------
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  owner              UUID,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  public             BOOLEAN DEFAULT false,
  avif_autodetection BOOLEAN DEFAULT false,
  file_size_limit    BIGINT,
  allowed_mime_types TEXT[],
  owner_id           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bname ON storage.buckets (name);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        TEXT REFERENCES storage.buckets (id),
  name             TEXT,
  owner            UUID,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  last_accessed_at TIMESTAMPTZ DEFAULT now(),
  metadata         JSONB,
  path_tokens      TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version          TEXT,
  owner_id         TEXT,
  user_metadata    JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS bucketid_objname ON storage.objects (bucket_id, name);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts TEXT[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END
$$;
CREATE OR REPLACE FUNCTION storage.filename(name TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts TEXT[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[array_length(_parts, 1)];
END
$$;
CREATE OR REPLACE FUNCTION storage.extension(name TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts TEXT[]; _filename TEXT;
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  SELECT _parts[array_length(_parts, 1)] INTO _filename;
  RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;
GRANT EXECUTE ON FUNCTION storage.foldername(TEXT), storage.filename(TEXT), storage.extension(TEXT) TO anon, authenticated, service_role;
