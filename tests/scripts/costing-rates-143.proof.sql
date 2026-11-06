-- Local proof for migration 143 (costing rates inside Tolra: costing_materials, costing_machines, costing_defaults). Run on a COPY of a
-- database with 000..135 applied, plus 143:
--   createdb m_cost143 -T <base>; psql -d m_cost143 -f supabase/release/143_costing_rates.release.sql
--   psql -d m_cost143 -f tests/scripts/costing-rates-143.proof.sql
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises (ON_ERROR_STOP).
-- Also run in CI by tests/db/costing-rates-143.test.ts, which drops the psql meta-commands (the lines starting with a backslash).
\set ON_ERROR_STOP 1
\set QUIET 1
\o /dev/null
BEGIN;
-- Two companies. A: admin, office, workshop, viewer. B: admin.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('14300000-0000-0000-0000-0000000000a0', 'Cost A', 't-cost143-a'), ('14300000-0000-0000-0000-0000000000b0', 'Cost B', 't-cost143-b');
INSERT INTO auth.users (id, email) VALUES
  ('14300000-0000-0000-0000-00000000a001', 'cost143.admin.a@example.test'), ('14300000-0000-0000-0000-00000000a002', 'cost143.office.a@example.test'),
  ('14300000-0000-0000-0000-00000000a003', 'cost143.workshop.a@example.test'), ('14300000-0000-0000-0000-00000000a004', 'cost143.viewer.a@example.test'),
  ('14300000-0000-0000-0000-00000000b001', 'cost143.admin.b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id) VALUES
  ('14300000-0000-0000-0000-00000000a001', 'cost143.admin.a@example.test', 'Admin A', 'admin', '14300000-0000-0000-0000-0000000000a0'),
  ('14300000-0000-0000-0000-00000000a002', 'cost143.office.a@example.test', 'Office A', 'office', '14300000-0000-0000-0000-0000000000a0'),
  ('14300000-0000-0000-0000-00000000a003', 'cost143.workshop.a@example.test', 'Workshop A', 'workshop', '14300000-0000-0000-0000-0000000000a0'),
  ('14300000-0000-0000-0000-00000000a004', 'cost143.viewer.a@example.test', 'Viewer A', 'viewer', '14300000-0000-0000-0000-0000000000a0'),
  ('14300000-0000-0000-0000-00000000b001', 'cost143.admin.b@example.test', 'Admin B', 'admin', '14300000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, full_name = EXCLUDED.full_name;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('14300000-0000-0000-0000-00000000a001', '14300000-0000-0000-0000-0000000000a0', 'admin'),
  ('14300000-0000-0000-0000-00000000a002', '14300000-0000-0000-0000-0000000000a0', 'office'),
  ('14300000-0000-0000-0000-00000000a003', '14300000-0000-0000-0000-0000000000a0', 'workshop'),
  ('14300000-0000-0000-0000-00000000a004', '14300000-0000-0000-0000-0000000000a0', 'viewer'),
  ('14300000-0000-0000-0000-00000000b001', '14300000-0000-0000-0000-0000000000b0', 'admin')
ON CONFLICT DO NOTHING;

-- Sign in as a person, as PostgREST would (role authenticated, the JWT claims).
CREATE FUNCTION pg_temp.sign_in(p_user TEXT, p_aal TEXT DEFAULT 'aal2') RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('role', 'none', TRUE),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::TEXT, TRUE),
         set_config('request.jwt.claim.sub', p_user, TRUE),
         set_config('request.headers', '{}', TRUE),
         set_config('role', 'authenticated', TRUE);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sign_in(TEXT, TEXT) TO authenticated;
CREATE FUNCTION pg_temp.expect_refused(p_sql TEXT, p_label TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_msg TEXT; v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_msg NOT ILIKE p_like THEN
      RAISE EXCEPTION 'FAIL % refused for the wrong reason: % %', p_label, v_state, v_msg;
    END IF;
    RAISE NOTICE 'PASS % refused (%: %)', p_label, v_state, v_msg;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % was allowed', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_refused(TEXT, TEXT, TEXT) TO authenticated;
CREATE FUNCTION pg_temp.ok(p_cond BOOLEAN, p_label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL %', p_label; END IF;
  RAISE NOTICE 'PASS %', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(BOOLEAN, TEXT) TO authenticated;
-- Rows changed by one statement run as the signed-in person (RLS hides a row: 0).
CREATE FUNCTION pg_temp.affected(p_sql TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.affected(TEXT) TO authenticated;

-- 1. Admin and office of company A write their own company's rates; the database stamps who and when.
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000a001');
INSERT INTO public.costing_materials (id, organization_id, name, price_pence, price_unit, scrap_pct, updated_by, updated_at)
  VALUES ('14300000-0000-0000-0000-0000000c0001', '14300000-0000-0000-0000-0000000000a0', 'Mild steel EN3B', 235, 'kg', 5, '14300000-0000-0000-0000-00000000b001', '2020-01-01');
INSERT INTO public.costing_machines (id, organization_id, name, hourly_rate_pence)
  VALUES ('14300000-0000-0000-0000-0000000d0001', '14300000-0000-0000-0000-0000000000a0', 'Haas VF-2', 6500);
INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 3250, 7500, 150, 20);
SELECT pg_temp.ok((SELECT updated_by = '14300000-0000-0000-0000-00000000a001' AND updated_at > '2021-01-01' FROM public.costing_materials
                   WHERE id = '14300000-0000-0000-0000-0000000c0001'), '1a admin adds a material; updated_by and updated_at are the database''s, not the client''s');
SELECT pg_temp.ok((SELECT labour_rate_pence = 3250 AND programming_rate_pence = 7500 AND overhead_pct = 150 AND default_margin_pct = 20
                   FROM public.costing_defaults WHERE organization_id = '14300000-0000-0000-0000-0000000000a0'), '1b admin saves defaults: the four figures stored are the ones entered (no built-in value)');
SELECT pg_temp.ok((SELECT labour_rate_pence IS NULL FROM public.costing_machines WHERE id = '14300000-0000-0000-0000-0000000d0001'),
                  '1c a machine with no labour rate of its own (the default applies)');
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000a002');
INSERT INTO public.costing_materials (id, organization_id, name, price_pence, price_unit, scrap_pct)
  VALUES ('14300000-0000-0000-0000-0000000c0002', '14300000-0000-0000-0000-0000000000a0', 'Insert blank', 45, 'each', 12.5);
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_machines SET hourly_rate_pence = 7000, labour_rate_pence = 3500 WHERE id = '14300000-0000-0000-0000-0000000d0001'$$) = 1,
                  '1d office changes a machine''s rates');
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_defaults SET default_margin_pct = 17.5, overhead_pct = 135 WHERE organization_id = '14300000-0000-0000-0000-0000000000a0'$$) = 1,
                  '1e office changes the defaults (fractional percentages kept)');
SELECT pg_temp.ok((SELECT count(*) = 2 FROM public.costing_materials) AND (SELECT count(*) = 1 FROM public.costing_machines) AND (SELECT count(*) = 1 FROM public.costing_defaults),
                  '1f office reads the company''s two materials, one machine and defaults');
INSERT INTO public.costing_machines (id, organization_id, name, hourly_rate_pence)
  VALUES ('14300000-0000-0000-0000-0000000d0002', '14300000-0000-0000-0000-0000000000a0', 'Old lathe', 3000);
SELECT pg_temp.ok(pg_temp.affected($$DELETE FROM public.costing_machines WHERE id = '14300000-0000-0000-0000-0000000d0002'$$) = 1, '1g office deletes a machine');
SELECT pg_temp.expect_refused($$UPDATE public.costing_materials SET organization_id = '14300000-0000-0000-0000-0000000000b0' WHERE id = '14300000-0000-0000-0000-0000000c0001'$$,
                              '1h office moves a material to another company', '%can''t move to another company%');

-- 2. Workshop and viewer neither read nor change rates.
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000a003');
SELECT pg_temp.ok((SELECT count(*) FROM public.costing_materials) + (SELECT count(*) FROM public.costing_machines) + (SELECT count(*) FROM public.costing_defaults) = 0,
                  '2a workshop reads no material, machine or defaults');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Workshop try', 1, 'kg', 5)$$,
                              '2b workshop adds a material', '%row-level security%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct) VALUES ('14300000-0000-0000-0000-0000000000b0', 1, 7500, 150, 20)$$,
                              '2c workshop adds defaults', '%row-level security%');
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_machines SET hourly_rate_pence = 1 WHERE id = '14300000-0000-0000-0000-0000000d0001'$$) = 0
                  AND pg_temp.affected($$DELETE FROM public.costing_materials$$) = 0
                  AND pg_temp.affected($$UPDATE public.costing_defaults SET labour_rate_pence = 1$$) = 0, '2d workshop changes and deletes nothing');
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000a004');
SELECT pg_temp.ok((SELECT count(*) FROM public.costing_materials) + (SELECT count(*) FROM public.costing_machines) + (SELECT count(*) FROM public.costing_defaults) = 0,
                  '2e viewer reads no material, machine or defaults');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name, hourly_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Viewer try', 1)$$,
                              '2f viewer adds a machine', '%row-level security%');
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_materials SET price_pence = 1$$) = 0
                  AND pg_temp.affected($$DELETE FROM public.costing_machines$$) = 0
                  AND pg_temp.affected($$DELETE FROM public.costing_defaults$$) = 0, '2g viewer changes and deletes nothing');

-- 3. Another company: B's admin neither reads nor writes A's rates, and keeps its own.
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000b001');
SELECT pg_temp.ok((SELECT count(*) FROM public.costing_materials) + (SELECT count(*) FROM public.costing_machines) + (SELECT count(*) FROM public.costing_defaults) = 0,
                  '3a company B reads none of A''s rates');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.costing_defaults) AND (SELECT count(*) = 0 FROM public.costing_materials) AND (SELECT count(*) = 0 FROM public.costing_machines),
                  '3a2 a company that has entered nothing has no defaults row, no material and no machine: costing is off for it (nothing is filled in for it)');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Planted', 1, 'kg', 5)$$,
                              '3b company B adds a material to A', '%row-level security%');
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_materials SET price_pence = 1 WHERE organization_id = '14300000-0000-0000-0000-0000000000a0'$$) = 0
                  AND pg_temp.affected($$DELETE FROM public.costing_defaults WHERE organization_id = '14300000-0000-0000-0000-0000000000a0'$$) = 0, '3c company B changes and deletes none of A''s rates');
INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000b0', 'Mild steel EN3B', 240, 'kg', 5);
INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct) VALUES ('14300000-0000-0000-0000-0000000000b0', 3000, 7500, 150, 20);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.costing_materials) AND (SELECT count(*) = 1 FROM public.costing_defaults),
                  '3d company B keeps its own material (the same name as A''s) and defaults');

-- 4. CHECKs (as A's admin): whole pence 0 to 10,000,000; percentages in range; kg or each; one-line names of 1 to 80; one name per company; one defaults row.
SELECT pg_temp.sign_in('14300000-0000-0000-0000-00000000a001');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 3000)$$,
                              '4a2 defaults with only a labour rate: no built-in programming rate', '%null value in column "programming_rate_pence"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 3000, 7500)$$,
                              '4a3 defaults with no overhead: no built-in overhead', '%null value in column "overhead_pct"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 3000, 7500, 150)$$,
                              '4a4 defaults with no margin: no built-in margin', '%null value in column "default_margin_pct"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'No unit', 1, 5)$$,
                              '4a5 a material with no price unit: no built-in unit', '%null value in column "price_unit"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit) VALUES ('14300000-0000-0000-0000-0000000000a0', 'No scrap', 1, 'kg')$$,
                              '4a6 a material with no scrap allowance: no built-in scrap', '%null value in column "scrap_pct"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Neg', -1, 'kg', 5)$$, '4a negative price', '%costing_materials_price"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Big', 10000001, 'kg', 5)$$, '4b price over GBP 100,000', '%costing_materials_price"%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence) SELECT organization_id, name, price_pence
                                FROM json_populate_record(NULL::public.costing_materials, '{"organization_id": "14300000-0000-0000-0000-0000000000a0", "name": "Frac", "price_pence": 2.5}')$$,
                              '4c a fractional penny sent as JSON (as PostgREST passes it) is not whole pence', '%invalid input syntax for type integer%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Lb', 1, 'lb', 5)$$, '4d price unit lb', '%costing_materials_price_unit%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'S1', 1, 'kg', 100.01)$$, '4e scrap over 100%', '%costing_materials_scrap%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 'S2', 1, 'kg', -0.01)$$, '4f negative scrap', '%costing_materials_scrap%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', '   ', 1, 'kg', 5)$$, '4g a blank name', '%costing_materials_name%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', E'Two\nlines', 1, 'kg', 5)$$, '4h a name on two lines', '%costing_materials_name%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name, hourly_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', repeat('m', 81), 1)$$, '4i a machine name of 81 characters', '%costing_machines_name%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_materials (organization_id, name, price_pence, price_unit, scrap_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', '  mild STEEL en3b ', 1, 'kg', 5)$$, '4j the same material name again (case and spaces ignored)', '%costing_materials_org_name%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name, hourly_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 'HAAS vf-2', 1)$$, '4k the same machine name again', '%costing_machines_org_name%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name, hourly_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Neg rate', -1)$$, '4l negative machine rate', '%costing_machines_hourly_rate%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name, hourly_rate_pence, labour_rate_pence) VALUES ('14300000-0000-0000-0000-0000000000a0', 'Neg labour', 1, -1)$$, '4m negative machine labour rate', '%costing_machines_labour_rate%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_machines (organization_id, name) VALUES ('14300000-0000-0000-0000-0000000000a0', 'No rate')$$, '4n a machine with no hourly rate', '%null value in column "hourly_rate_pence"%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET overhead_pct = 99.99$$, '4o overhead under 100 (would take cost away)', '%costing_defaults_overhead%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET overhead_pct = 500.01$$, '4p overhead over 500', '%costing_defaults_overhead%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET default_margin_pct = 95.01$$, '4q margin over 95', '%costing_defaults_margin%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET default_margin_pct = -1$$, '4r negative margin', '%costing_defaults_margin%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET labour_rate_pence = -1$$, '4s negative labour rate', '%costing_defaults_labour_rate%');
SELECT pg_temp.expect_refused($$UPDATE public.costing_defaults SET programming_rate_pence = 10000001$$, '4t programming rate over GBP 100,000', '%costing_defaults_programming_rate%');
SELECT pg_temp.expect_refused($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 1, 7500, 150, 20)$$, '4u a second defaults row for the company', '%costing_defaults_org%');
SELECT pg_temp.ok(pg_temp.affected($$INSERT INTO public.costing_defaults (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct) VALUES ('14300000-0000-0000-0000-0000000000a0', 4000, 7500, 150, 20)
                                    ON CONFLICT (organization_id) DO UPDATE SET labour_rate_pence = EXCLUDED.labour_rate_pence$$) = 1,
                  '4v upsert on organization_id (what the app saves with)');
SELECT pg_temp.ok((SELECT labour_rate_pence = 4000 AND default_margin_pct = 17.5 FROM public.costing_defaults), '4w the upsert changed the labour rate and kept the margin');
SELECT pg_temp.ok(pg_temp.affected($$UPDATE public.costing_materials SET price_pence = 10000000, scrap_pct = 100 WHERE id = '14300000-0000-0000-0000-0000000c0001'$$) = 1
                  AND pg_temp.affected($$UPDATE public.costing_defaults SET overhead_pct = 500, default_margin_pct = 95, labour_rate_pence = 0, programming_rate_pence = 0$$) = 1,
                  '4x the limits themselves are allowed');

-- 5. Signed out (anon) has no access at all; every change is in the audit log.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_refused($$SELECT 1 FROM public.costing_materials$$, '5a anon reads materials', '%permission denied%');
SELECT pg_temp.expect_refused($$SELECT 1 FROM public.costing_defaults$$, '5b anon reads defaults', '%permission denied%');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(DISTINCT entity_table) = 3 FROM security_audit.audit_log
                   WHERE organization_id = '14300000-0000-0000-0000-0000000000a0' AND entity_table IN ('costing_materials', 'costing_machines', 'costing_defaults')),
                  '5c changes to all three tables are in the audit log');

ROLLBACK;
\o
\echo costing-rates-143 proof: rolled back
