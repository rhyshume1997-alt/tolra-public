-- Synthetic prerequisites for migration 148 tests. Auth/access helpers model request claims, not the full Auth service.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE organizations(id uuid PRIMARY KEY);
CREATE TABLE jobs(id uuid PRIMARY KEY, organization_id uuid, quote_id uuid);
CREATE TABLE machines(id uuid PRIMARY KEY, organization_id uuid, name text);
CREATE TABLE operator_sessions(id uuid,organization_id uuid,job_id uuid,user_id uuid,started_at timestamptz,ended_at timestamptz,voided_at timestamptz);
CREATE TABLE machine_runs(id uuid,organization_id uuid,job_id uuid,machine_id uuid,operator_id uuid,started_at timestamptz,ended_at timestamptz);
CREATE TABLE job_machines(organization_id uuid,job_id uuid,machine_id uuid,estimated_hours numeric);
CREATE TABLE purchase_orders(id uuid,organization_id uuid,job_id uuid,quote_id uuid,status text,total_value numeric,linked_net numeric);
CREATE TABLE invoices(id uuid,organization_id uuid,job_id uuid,status text,subtotal numeric);
CREATE TABLE credit_notes(organization_id uuid,invoice_id uuid,status text,subtotal numeric);
CREATE TABLE quote_line_items(organization_id uuid,quote_id uuid,quantity numeric,unit_price numeric,declined boolean);
CREATE FUNCTION current_user_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.org',true),'')::uuid $$;
CREATE FUNCTION has_org_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.role',true) = ANY(roles),false) $$;
CREATE FUNCTION section_allowed(section text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.denied',true),'') <> section $$;
CREATE FUNCTION session_read_only() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.readonly',true),'false') = 'true' $$;
CREATE FUNCTION assert_privileged_aal() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF current_setting('test.mfa',true) IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'MFA required' USING ERRCODE='42501'; END IF; END $$;
CREATE FUNCTION support_readonly_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE='42501'; END IF; RETURN NULL; END $$;
CREATE FUNCTION enforce_same_org_parent() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE org uuid; BEGIN
 EXECUTE format('SELECT organization_id FROM public.%I WHERE id=$1',TG_ARGV[0]) INTO org USING (to_jsonb(NEW)->>TG_ARGV[1])::uuid;
 IF org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Cross company' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;
INSERT INTO organizations VALUES ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000010');
INSERT INTO jobs VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031'),
 ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002',null);
INSERT INTO machines VALUES ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000001','Synthetic mill'),
 ('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000002','Other mill');
INSERT INTO invoices VALUES ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','sent',200),
 ('00000000-0000-0000-0000-000000000042','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000012','sent',999);
INSERT INTO credit_notes VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000041','issued',10);
INSERT INTO quote_line_items VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031',1,200,false);
INSERT INTO purchase_orders VALUES ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',null,'sent',100,10);
INSERT INTO operator_sessions VALUES ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000010','2026-11-04 08:00Z','2026-11-04 09:00Z',null);
INSERT INTO machine_runs VALUES ('00000000-0000-0000-0000-000000000071','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000010','2026-11-04 08:00Z','2026-11-04 09:00Z');
INSERT INTO job_machines VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',1);
