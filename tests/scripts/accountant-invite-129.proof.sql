-- =====================================================================================================================================
-- Migration 129 proof ("Invite your accountant": an expiring, single-use VIEWER invite on 007's organization_invites). Plain SQL (no psql
-- meta-commands), so tests/db/accountant-invite-129.test.ts runs this same file through node-postgres on the CI stack. By hand, against a
-- DISPOSABLE database with the chain applied through 129 (never production):
--
--   PGPASSWORD=... psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d <disposable> -f tests/scripts/accountant-invite-129.proof.sql
--
-- ONE transaction, ROLLED BACK at the end: no company, login, invite or audit row is left behind. Every property prints "ok ..." (NOTICE);
-- the first one that does not hold raises "FAIL ...". The last result row is the summary: result = 'PASS accountant invite 129 proof'.
-- Signed-in calls run as PostgREST runs them: role authenticated with request.jwt.claims (sub, email, session_id, aal).
--
-- Proves: create by an admin (aal2) of the current company; refused for office, viewer, an aal1 admin, and an admin whose session is in
-- another company where they are not admin; the role is always viewer (the CHECK refuses anything else); 7 days; only the hash is kept and
-- it is not readable through the API; an e-mail already a member, or with an ordinary invite, is refused; inviting again replaces the link.
-- Redeem: the invite's e-mail only, once; refused when expired, revoked or used; an existing login gets a viewer membership and keeps its
-- other company as it was; an existing member keeps their role (never raised or changed); a switched-off membership is not revived.
-- Revoke: admin of the company only; another company's admin gets FALSE and reads none of its invites. Sign-up trigger: a valid
-- accountant invite becomes a viewer membership and is marked used; expired and revoked ones are skipped (no membership, row kept);
-- ordinary invites exactly as 007 (membership with the invite's role, invite deleted). Every action writes its audit row.
-- =====================================================================================================================================
BEGIN;

CREATE TEMP TABLE proof_people (key TEXT PRIMARY KEY, id UUID NOT NULL, email TEXT NOT NULL, session UUID, aal TEXT NOT NULL DEFAULT 'aal2') ON COMMIT DROP;
CREATE TEMP TABLE proof_count (n INTEGER NOT NULL) ON COMMIT DROP;
INSERT INTO proof_count VALUES (0);

-- Two companies. A: admin (also a viewer of B), office, viewer, an existing member (office), a switched-off member. B: admin, and the
-- accountant's existing login (office of B only).
INSERT INTO public.organizations (id, name, slug, status) VALUES
  ('12900000-0000-4000-8000-0000000000a0', 'Accountant Proof A', 'proof129-a', 'active'),
  ('12900000-0000-4000-8000-0000000000b0', 'Accountant Proof B', 'proof129-b', 'active');
INSERT INTO proof_people (key, id, email, session) VALUES
  ('adminA',  '12900000-0000-4000-8000-00000000a001', 'admin.a.129@example.test', '12900000-0000-4000-8000-0000000005a1'),
  ('adminAinB', '12900000-0000-4000-8000-00000000a001', 'admin.a.129@example.test', '12900000-0000-4000-8000-0000000005b1'),
  ('officeA', '12900000-0000-4000-8000-00000000a002', 'office.a.129@example.test', NULL),
  ('viewerA', '12900000-0000-4000-8000-00000000a003', 'viewer.a.129@example.test', NULL),
  ('memberA', '12900000-0000-4000-8000-00000000a004', 'member.a.129@example.test', NULL),
  ('offA',    '12900000-0000-4000-8000-00000000a005', 'off.a.129@example.test', NULL),
  ('adminB',  '12900000-0000-4000-8000-00000000b001', 'admin.b.129@example.test', NULL),
  ('acct',    '12900000-0000-4000-8000-00000000c001', 'acct.129@example.test', NULL),
  ('late',    '12900000-0000-4000-8000-00000000c002', 'late.129@example.test', NULL);
INSERT INTO proof_people (key, id, email, session, aal) VALUES
  ('adminA1', '12900000-0000-4000-8000-00000000a001', 'admin.a.129@example.test', '12900000-0000-4000-8000-0000000005a1', 'aal1');
INSERT INTO auth.users (id, email) SELECT DISTINCT id, email FROM proof_people;
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) VALUES
  ('12900000-0000-4000-8000-00000000a001', 'admin.a.129@example.test', 'Admin A', 'admin', '12900000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000a002', 'office.a.129@example.test', 'Office A', 'office', '12900000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000a003', 'viewer.a.129@example.test', 'Viewer A', 'viewer', '12900000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000a004', 'member.a.129@example.test', 'Member A', 'office', '12900000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000a005', 'off.a.129@example.test', 'Off A', 'office', '12900000-0000-4000-8000-0000000000b0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000b001', 'admin.b.129@example.test', 'Admin B', 'admin', '12900000-0000-4000-8000-0000000000b0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000c001', 'acct.129@example.test', 'Accountant', 'office', '12900000-0000-4000-8000-0000000000b0', TRUE, FALSE),
  ('12900000-0000-4000-8000-00000000c002', 'late.129@example.test', 'Late', 'workshop', '12900000-0000-4000-8000-0000000000b0', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES
  ('12900000-0000-4000-8000-00000000a001', '12900000-0000-4000-8000-0000000000a0', 'admin', TRUE),
  ('12900000-0000-4000-8000-00000000a001', '12900000-0000-4000-8000-0000000000b0', 'viewer', TRUE),
  ('12900000-0000-4000-8000-00000000a002', '12900000-0000-4000-8000-0000000000a0', 'office', TRUE),
  ('12900000-0000-4000-8000-00000000a003', '12900000-0000-4000-8000-0000000000a0', 'viewer', TRUE),
  ('12900000-0000-4000-8000-00000000a004', '12900000-0000-4000-8000-0000000000a0', 'office', TRUE),
  ('12900000-0000-4000-8000-00000000a005', '12900000-0000-4000-8000-0000000000a0', 'office', FALSE),
  ('12900000-0000-4000-8000-00000000a005', '12900000-0000-4000-8000-0000000000b0', 'office', TRUE),
  ('12900000-0000-4000-8000-00000000b001', '12900000-0000-4000-8000-0000000000b0', 'admin', TRUE),
  ('12900000-0000-4000-8000-00000000c001', '12900000-0000-4000-8000-0000000000b0', 'office', TRUE),
  ('12900000-0000-4000-8000-00000000c002', '12900000-0000-4000-8000-0000000000b0', 'workshop', TRUE)
ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
INSERT INTO auth.sessions (id, user_id) VALUES
  ('12900000-0000-4000-8000-0000000005a1', '12900000-0000-4000-8000-00000000a001'), ('12900000-0000-4000-8000-0000000005b1', '12900000-0000-4000-8000-00000000a001');
INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES
  ('12900000-0000-4000-8000-0000000005a1', '12900000-0000-4000-8000-00000000a001', '12900000-0000-4000-8000-0000000000a0'),
  ('12900000-0000-4000-8000-0000000005b1', '12900000-0000-4000-8000-00000000a001', '12900000-0000-4000-8000-0000000000b0');

-- The token's hash, as the server computes it (lib/integrations/invite.ts hashInviteToken: SHA-256 hex of the UTF-8 token).
CREATE FUNCTION pg_temp.h(p_token TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

-- Runs one SELECT as a signed-in person; returns its single value as text, or 'ERR:<sqlstate>:<hint>'. The role and claims are reset after.
CREATE FUNCTION pg_temp.as_(p_key TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE p RECORD; v TEXT; v_state TEXT; v_hint TEXT;
BEGIN
  SELECT * INTO p FROM proof_people WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL proof: no person %', p_key; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p.id, 'email', p.email, 'role', 'authenticated', 'aud', 'authenticated',
                                                              'aal', p.aal, 'session_id', p.session)::TEXT, TRUE);
  PERFORM set_config('role', 'authenticated', TRUE);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    v := 'ERR:' || v_state || ':' || coalesce(v_hint, '');
  END;
  PERFORM set_config('role', 'postgres', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.ok(p_label TEXT, p_got TEXT, p_want TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want AND NOT (p_want LIKE '%\%%' AND p_got LIKE p_want) THEN
    RAISE EXCEPTION 'FAIL %: got %, want %', p_label, coalesce(p_got, 'NULL'), p_want;
  END IF;
  UPDATE proof_count SET n = n + 1;
  RAISE NOTICE 'ok %', p_label;
END $$;

-- Runs a statement as the table owner (the database), returning 'ok' or 'ERR:<sqlstate>'.
CREATE FUNCTION pg_temp.owner_try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN 'ERR:' || v_state;
  END;
  RETURN 'ok';
END $$;

CREATE FUNCTION pg_temp.events(p_action TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT count(*)::TEXT FROM security_audit.audit_log
  WHERE action = p_action AND organization_id = '12900000-0000-4000-8000-0000000000a0' AND created_at >= now() - interval '1 minute'
$$;

CREATE FUNCTION pg_temp.member(p_user UUID, p_org UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT coalesce((SELECT role || ':' || active::TEXT FROM public.organization_members WHERE user_id = p_user AND organization_id = p_org), 'none')
$$;

DO $$
DECLARE
  v TEXT;
  A CONSTANT UUID := '12900000-0000-4000-8000-0000000000a0';
  B CONSTANT UUID := '12900000-0000-4000-8000-0000000000b0';
  v_inv UUID;
  v_new UUID;
BEGIN
  -- ===== 1. Create: who may =====
  PERFORM pg_temp.ok('office is refused', pg_temp.as_('officeA', $q$SELECT public.create_accountant_invite('x1@example.test', pg_temp.h('t-x1'))::TEXT$q$), 'ERR:42501:');
  PERFORM pg_temp.ok('viewer is refused', pg_temp.as_('viewerA', $q$SELECT public.create_accountant_invite('x1@example.test', pg_temp.h('t-x1'))::TEXT$q$), 'ERR:42501:');
  PERFORM pg_temp.ok('admin without the second step (aal1) is refused', pg_temp.as_('adminA1', $q$SELECT public.create_accountant_invite('x1@example.test', pg_temp.h('t-x1'))::TEXT$q$), 'ERR:42501:mfa_required');
  PERFORM pg_temp.ok('admin of A whose session is in B (viewer there) is refused: bound to the current company', pg_temp.as_('adminAinB', $q$SELECT public.create_accountant_invite('x1@example.test', pg_temp.h('t-x1'))::TEXT$q$), 'ERR:42501:');
  PERFORM pg_temp.ok('a malformed hash is refused', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('x1@example.test', 'not-a-hash')::TEXT$q$), 'ERR:22023:');
  PERFORM pg_temp.ok('a malformed e-mail is refused', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('not an email', pg_temp.h('t-x1'))::TEXT$q$), 'ERR:22023:');
  PERFORM pg_temp.ok('nothing written by the refusals', (SELECT count(*)::TEXT FROM public.organization_invites WHERE organization_id IN (A, B)), '0');

  v := pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('  Acct.129@Example.test ', pg_temp.h('t-acct'))::TEXT$q$);
  PERFORM pg_temp.ok('admin (aal2) of A creates: viewer, the e-mail lower-cased', (v::JSONB ->> 'role') || ' ' || (v::JSONB ->> 'email'), 'viewer acct.129@example.test');
  v_inv := (v::JSONB ->> 'id')::UUID;
  PERFORM pg_temp.ok('stored: company A, viewer, the hash only, by the admin, 7 days', (SELECT organization_id::TEXT || ' ' || role || ' ' || (token_hash = pg_temp.h('t-acct'))::TEXT || ' '
      || created_by::TEXT || ' ' || (abs(extract(epoch FROM expires_at - (now() + interval '7 days'))) < 5)::TEXT FROM public.organization_invites WHERE id = v_inv),
    A::TEXT || ' viewer true 12900000-0000-4000-8000-00000000a001 true');
  PERFORM pg_temp.ok('the plain token is stored nowhere in the row', (SELECT (row_to_json(i)::TEXT LIKE '%t-acct%')::TEXT FROM public.organization_invites i WHERE id = v_inv), 'false');
  PERFORM pg_temp.ok('a role other than viewer is refused by the CHECK (even for the owner)', pg_temp.owner_try(format('UPDATE public.organization_invites SET role = %L WHERE id = %L', 'admin', v_inv)), 'ERR:23514');
  PERFORM pg_temp.ok('an accountant invite without an expiry is refused by the CHECK', pg_temp.owner_try(format('UPDATE public.organization_invites SET expires_at = NULL WHERE id = %L', v_inv)), 'ERR:23514');
  PERFORM pg_temp.ok('ACCOUNTANT_INVITE_CREATED written', pg_temp.events('ACCOUNTANT_INVITE_CREATED'), '1');

  -- An e-mail that is already a member here, switched off here, or holds an ordinary invite here, is refused.
  PERFORM pg_temp.ok('an existing member of A is refused (already_member)', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('member.a.129@example.test', pg_temp.h('t-m'))::TEXT$q$), 'ERR:23505:already_member');
  PERFORM pg_temp.ok('a switched-off member of A is refused (already_member)', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('off.a.129@example.test', pg_temp.h('t-o'))::TEXT$q$), 'ERR:23505:already_member');
  PERFORM public.add_member(A, 'plain.129@example.test', 'office');
  PERFORM pg_temp.ok('an e-mail with an ordinary invite here is refused (already_invited)', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('plain.129@example.test', pg_temp.h('t-p'))::TEXT$q$), 'ERR:23505:already_invited');
  PERFORM pg_temp.ok('the ordinary invite is untouched', (SELECT role || ' ' || (token_hash IS NULL AND expires_at IS NULL)::TEXT FROM public.organization_invites WHERE organization_id = A AND email = 'plain.129@example.test'), 'office true');

  -- ===== 2. Reading: admins of A see A's invites, never the hash; B's admin sees none of A's; peek is server-only =====
  PERFORM pg_temp.ok('the token hash is not readable through the API', pg_temp.as_('adminA', $q$SELECT count(token_hash)::TEXT FROM public.organization_invites$q$), 'ERR:42501:');
  PERFORM pg_temp.ok('admin of A reads A''s invites (e-mail, role, expiry)', pg_temp.as_('adminA', $q$SELECT string_agg(email || ':' || role || ':' || (expires_at IS NOT NULL)::TEXT, ',' ORDER BY email) FROM public.organization_invites$q$),
    'acct.129@example.test:viewer:true,plain.129@example.test:office:false');
  PERFORM pg_temp.ok('admin of B reads none of A''s invites', pg_temp.as_('adminB', $q$SELECT count(*)::TEXT FROM public.organization_invites WHERE organization_id = '12900000-0000-4000-8000-0000000000a0'$q$), '0');
  PERFORM pg_temp.ok('office of A reads no invites (admins only, as 007)', pg_temp.as_('officeA', $q$SELECT count(*)::TEXT FROM public.organization_invites$q$), '0');
  PERFORM pg_temp.ok('nobody signed in writes an invite directly', pg_temp.as_('adminA', $q$INSERT INTO public.organization_invites (organization_id, email, role) VALUES ('12900000-0000-4000-8000-0000000000a0', 'd@example.test', 'admin') RETURNING 'written'$q$), 'ERR:42501:');
  PERFORM pg_temp.ok('peek is refused to a signed-in person', pg_temp.as_('adminA', $q$SELECT public.accountant_invite_peek(pg_temp.h('t-acct'))::TEXT$q$), 'ERR:42501:');
  PERFORM set_config('role', 'service_role', TRUE);
  v := public.accountant_invite_peek(pg_temp.h('t-acct'))::TEXT;
  PERFORM set_config('role', 'postgres', TRUE);
  PERFORM pg_temp.ok('peek (server): company name, e-mail, Xero not connected; nothing used up',
    (v::JSONB ->> 'company_name') || ' ' || (v::JSONB ->> 'email') || ' ' || (v::JSONB ->> 'xero_connected') || ' ' || (SELECT (used_at IS NULL)::TEXT FROM public.organization_invites WHERE id = v_inv),
    'Accountant Proof A acct.129@example.test false true');
  PERFORM pg_temp.ok('peek of an unknown token is NULL', coalesce(public.accountant_invite_peek(pg_temp.h('nope'))::TEXT, 'NULL'), 'NULL');

  -- ===== 3. Redeem =====
  PERFORM pg_temp.ok('another login cannot use it (invite_other_email)', pg_temp.as_('late', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-acct'))::TEXT$q$), 'ERR:42501:invite_other_email');
  PERFORM pg_temp.ok('an unknown token is refused', pg_temp.as_('acct', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-wrong'))::TEXT$q$), 'ERR:42501:invite_invalid');
  v := pg_temp.as_('acct', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-acct'))::TEXT$q$);
  PERFORM pg_temp.ok('the accountant''s existing login joins A', (v::JSONB ->> 'status') || ' ' || (v::JSONB ->> 'company_name'), 'joined Accountant Proof A');
  PERFORM pg_temp.ok('as viewer of A', pg_temp.member('12900000-0000-4000-8000-00000000c001', A), 'viewer:true');
  PERFORM pg_temp.ok('their own company (B) is unchanged', pg_temp.member('12900000-0000-4000-8000-00000000c001', B), 'office:true');
  PERFORM pg_temp.ok('their profile and current company are unchanged', (SELECT role || ' ' || organization_id::TEXT FROM public.user_profiles WHERE id = '12900000-0000-4000-8000-00000000c001'), 'office ' || B::TEXT);
  PERFORM pg_temp.ok('the invite is marked used (kept)', (SELECT (used_at IS NOT NULL)::TEXT FROM public.organization_invites WHERE id = v_inv), 'true');
  PERFORM pg_temp.ok('a second use is refused', pg_temp.as_('acct', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-acct'))::TEXT$q$), 'ERR:42501:invite_invalid');
  PERFORM pg_temp.ok('ACCOUNTANT_INVITE_USED written once', pg_temp.events('ACCOUNTANT_INVITE_USED'), '1');
  PERFORM pg_temp.ok('a used invite is no longer revocable', pg_temp.as_('adminA', format('SELECT public.revoke_accountant_invite(%L)::TEXT', v_inv)), 'false');
  PERFORM pg_temp.ok('a member who joined cannot be invited again', pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('acct.129@example.test', pg_temp.h('t-acct2'))::TEXT$q$), 'ERR:23505:already_member');

  -- Never raised: an invite made, then the person became an office member of A some other way; redeeming leaves them office.
  PERFORM pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('late.129@example.test', pg_temp.h('t-late'))::TEXT$q$);
  INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES ('12900000-0000-4000-8000-00000000c002', A, 'office', TRUE);
  v := pg_temp.as_('late', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-late'))::TEXT$q$);
  PERFORM pg_temp.ok('an existing member redeeming: already_member', v::JSONB ->> 'status', 'already_member');
  PERFORM pg_temp.ok('their role is unchanged (office, not lowered or raised)', pg_temp.member('12900000-0000-4000-8000-00000000c002', A), 'office:true');
  UPDATE public.organization_members SET active = FALSE WHERE user_id = '12900000-0000-4000-8000-00000000c002' AND organization_id = A;
  UPDATE public.organization_invites SET used_at = NULL WHERE organization_id = A AND email = 'late.129@example.test';
  PERFORM pg_temp.ok('a switched-off membership is not revived (membership_inactive)', pg_temp.as_('late', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-late'))::TEXT$q$), 'ERR:42501:membership_inactive');
  PERFORM pg_temp.ok('and stays off', pg_temp.member('12900000-0000-4000-8000-00000000c002', A), 'office:false');

  -- ===== 4. Expiry, revoke, re-invite =====
  PERFORM pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('exp.129@example.test', pg_temp.h('t-exp'))::TEXT$q$);
  UPDATE public.organization_invites SET expires_at = now() - interval '1 second' WHERE organization_id = A AND email = 'exp.129@example.test';
  INSERT INTO auth.users (id, email) VALUES ('12900000-0000-4000-8000-00000000c003', 'exp.129@example.test');
  INSERT INTO proof_people (key, id, email) VALUES ('exp', '12900000-0000-4000-8000-00000000c003', 'exp.129@example.test');
  PERFORM pg_temp.ok('sign-up with only an EXPIRED accountant invite: no membership, no profile', pg_temp.member('12900000-0000-4000-8000-00000000c003', A) || ' '
    || EXISTS (SELECT 1 FROM public.user_profiles WHERE id = '12900000-0000-4000-8000-00000000c003')::TEXT, 'none false');
  PERFORM pg_temp.ok('the expired invite is kept, not used', (SELECT (used_at IS NULL)::TEXT FROM public.organization_invites WHERE organization_id = A AND email = 'exp.129@example.test'), 'true');
  PERFORM pg_temp.ok('an expired invite is refused on redeem', pg_temp.as_('exp', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-exp'))::TEXT$q$), 'ERR:42501:invite_invalid');
  PERFORM pg_temp.ok('an expired invite is not revocable', pg_temp.as_('adminA', format('SELECT public.revoke_accountant_invite(%L)::TEXT', (SELECT id FROM public.organization_invites WHERE organization_id = A AND email = 'exp.129@example.test'))), 'false');

  v := pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('rev.129@example.test', pg_temp.h('t-rev'))::TEXT$q$);
  v_inv := (v::JSONB ->> 'id')::UUID;
  PERFORM pg_temp.ok('office cannot revoke', pg_temp.as_('officeA', format('SELECT public.revoke_accountant_invite(%L)::TEXT', v_inv)), 'ERR:42501:');
  PERFORM pg_temp.ok('admin of B cannot revoke A''s invite (FALSE, nothing changed)', pg_temp.as_('adminB', format('SELECT public.revoke_accountant_invite(%L)::TEXT', v_inv))
    || ' ' || (SELECT (revoked_at IS NULL)::TEXT FROM public.organization_invites WHERE id = v_inv), 'false true');
  PERFORM pg_temp.ok('an ordinary invite is not revoked by this function', pg_temp.as_('adminA', format('SELECT public.revoke_accountant_invite(%L)::TEXT',
    (SELECT id FROM public.organization_invites WHERE organization_id = A AND email = 'plain.129@example.test'))), 'false');
  PERFORM pg_temp.ok('admin of A revokes', pg_temp.as_('adminA', format('SELECT public.revoke_accountant_invite(%L)::TEXT', v_inv)), 'true');
  PERFORM pg_temp.ok('revoking again: FALSE', pg_temp.as_('adminA', format('SELECT public.revoke_accountant_invite(%L)::TEXT', v_inv)), 'false');
  PERFORM pg_temp.ok('ACCOUNTANT_INVITE_REVOKED written once', pg_temp.events('ACCOUNTANT_INVITE_REVOKED'), '1');
  INSERT INTO auth.users (id, email) VALUES ('12900000-0000-4000-8000-00000000c004', 'rev.129@example.test');
  INSERT INTO proof_people (key, id, email) VALUES ('rev', '12900000-0000-4000-8000-00000000c004', 'rev.129@example.test');
  PERFORM pg_temp.ok('sign-up with only a REVOKED accountant invite: no membership', pg_temp.member('12900000-0000-4000-8000-00000000c004', A), 'none');
  PERFORM pg_temp.ok('a revoked invite is refused on redeem', pg_temp.as_('rev', $q$SELECT public.redeem_accountant_invite(pg_temp.h('t-rev'))::TEXT$q$), 'ERR:42501:invite_invalid');

  -- Inviting the same e-mail again replaces the link: the old token stops working, the new one works.
  PERFORM pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('again.129@example.test', pg_temp.h('t-old'))::TEXT$q$);
  v := pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('again.129@example.test', pg_temp.h('t-new'))::TEXT$q$);
  PERFORM pg_temp.ok('inviting again: one row, the new hash', (SELECT count(*)::TEXT || ' ' || bool_and(token_hash = pg_temp.h('t-new'))::TEXT FROM public.organization_invites WHERE organization_id = A AND email = 'again.129@example.test'), '1 true');
  INSERT INTO auth.users (id, email) VALUES ('12900000-0000-4000-8000-00000000c005', 'again.129@example.test');
  -- (that login was created after the invite: the sign-up trigger already made it a viewer; see section 5)
  PERFORM pg_temp.ok('the replaced link''s old token peeks as nothing', coalesce(public.accountant_invite_peek(pg_temp.h('t-old'))::TEXT, 'NULL'), 'NULL');

  -- ===== 5. Sign-up trigger =====
  PERFORM pg_temp.ok('sign-up with a valid accountant invite: viewer of A', pg_temp.member('12900000-0000-4000-8000-00000000c005', A), 'viewer:true');
  PERFORM pg_temp.ok('profile made with A as current company, role viewer', (SELECT role || ' ' || organization_id::TEXT FROM public.user_profiles WHERE id = '12900000-0000-4000-8000-00000000c005'), 'viewer ' || A::TEXT);
  PERFORM pg_temp.ok('that invite is marked used and kept', (SELECT (used_at IS NOT NULL)::TEXT FROM public.organization_invites WHERE organization_id = A AND email = 'again.129@example.test'), 'true');
  PERFORM pg_temp.ok('its token can''t be used afterwards', coalesce(public.accountant_invite_peek(pg_temp.h('t-new'))::TEXT, 'NULL'), 'NULL');
  PERFORM pg_temp.ok('ACCOUNTANT_INVITE_USED by sign-up written', (SELECT count(*)::TEXT FROM security_audit.audit_log WHERE action = 'ACCOUNTANT_INVITE_USED' AND organization_id = A AND metadata ->> 'via' = 'sign_up'), '1');

  -- Ordinary invites, exactly as 007: add_member answers 'invited'; sign-up makes a membership with the invite's role and deletes it.
  PERFORM pg_temp.ok('add_member for an unknown e-mail still answers invited', public.add_member(B, 'plain.129@example.test', 'workshop'), 'invited');
  PERFORM pg_temp.ok('the ordinary invites have none of the new columns', (SELECT count(*)::TEXT FROM public.organization_invites WHERE email = 'plain.129@example.test'
    AND token_hash IS NULL AND expires_at IS NULL AND used_at IS NULL AND revoked_at IS NULL AND created_by IS NULL), '2');
  -- The same e-mail also gets an accountant invite to B (no ordinary one there now would clash, so use a fresh e-mail for the mix below).
  -- 007 takes the profile's company from the OLDEST invite (ties by id); everything here shares one transaction time, so make A's older.
  UPDATE public.organization_invites SET created_at = now() - interval '1 minute' WHERE organization_id = A AND email = 'plain.129@example.test';
  v_new := '12900000-0000-4000-8000-00000000c006';
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_new, 'Plain.129@example.test', '{"full_name": "Plain Person"}');
  PERFORM pg_temp.ok('ordinary invites: a membership of each company with the invite''s role', pg_temp.member(v_new, A) || ' ' || pg_temp.member(v_new, B), 'office:true workshop:true');
  PERFORM pg_temp.ok('ordinary invites: profile from the first invite, name from the metadata', (SELECT role || ' ' || organization_id::TEXT || ' ' || full_name FROM public.user_profiles WHERE id = v_new), 'office ' || A::TEXT || ' Plain Person');
  PERFORM pg_temp.ok('ordinary invites: deleted after sign-up', (SELECT count(*)::TEXT FROM public.organization_invites WHERE lower(email) = 'plain.129@example.test'), '0');

  -- Mixed: an ordinary invite to B and an open accountant invite to A for one e-mail: both become memberships, only the ordinary one is deleted.
  PERFORM public.add_member(B, 'mix.129@example.test', 'office');
  PERFORM pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('mix.129@example.test', pg_temp.h('t-mix'))::TEXT$q$);
  INSERT INTO auth.users (id, email) VALUES ('12900000-0000-4000-8000-00000000c007', 'mix.129@example.test');
  PERFORM pg_temp.ok('mixed: viewer of A (accountant), office of B (ordinary)', pg_temp.member('12900000-0000-4000-8000-00000000c007', A) || ' ' || pg_temp.member('12900000-0000-4000-8000-00000000c007', B), 'viewer:true office:true');
  PERFORM pg_temp.ok('mixed: the ordinary invite deleted, the accountant one kept as used', (SELECT string_agg(organization_id::TEXT || ':' || (used_at IS NOT NULL)::TEXT, ',') FROM public.organization_invites WHERE email = 'mix.129@example.test'), A::TEXT || ':true');

  -- The platform owner's add_member on an e-mail with an OPEN accountant invite is refused by the CHECK (it would make it another role).
  PERFORM pg_temp.as_('adminA', $q$SELECT public.create_accountant_invite('clash.129@example.test', pg_temp.h('t-clash'))::TEXT$q$);
  PERFORM pg_temp.ok('add_member cannot turn an accountant invite into another role', pg_temp.owner_try(format('SELECT public.add_member(%L, %L, %L)', A, 'clash.129@example.test', 'admin')), 'ERR:23514');

  -- ===== 6. Audit totals for A, and the role of every accountant row =====
  PERFORM pg_temp.ok('every accountant invite row is viewer', (SELECT string_agg(DISTINCT role, ',') FROM public.organization_invites WHERE token_hash IS NOT NULL), 'viewer');
  PERFORM pg_temp.ok('ACCOUNTANT_INVITE_CREATED: one per create (acct, late, exp, rev, again x2, mix, clash)', pg_temp.events('ACCOUNTANT_INVITE_CREATED'), '8');
  PERFORM pg_temp.ok('no audit row carries a token or a hash', (SELECT count(*)::TEXT FROM security_audit.audit_log WHERE action LIKE 'ACCOUNTANT_INVITE_%'
    AND (metadata::TEXT LIKE '%' || pg_temp.h('t-acct') || '%' OR metadata::TEXT LIKE '%t-acct%' OR metadata ? 'token_hash')), '0');
END
$$;

SELECT 'PASS accountant invite 129 proof' AS result, n AS checks FROM proof_count;

ROLLBACK;
