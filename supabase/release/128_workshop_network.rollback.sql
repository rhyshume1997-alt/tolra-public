-- 128 rollback: ONLY with Rhys's approval. Puts back 078's public.site_network_ip_purge and public.purge_site_network_ips byte for byte
-- (same signatures, security, search_path and grants), removes rename_site_network, record_clock_in_refusal and their two internal
-- helpers, DROPS public.clock_in_network_refusals (the refused clock actions recorded since 128, with any address still kept: they are
-- lost; export them first if they are wanted) and narrows site_network_ops.kind back to 075's list. The keyed 'rename' saves are deleted
-- first (they are only replay answers; the renamed labels themselves stay). Nothing else changes: no site network, lock, exception or
-- switch. Run the whole text as one transaction, then the release preflight (marker 128 shows "not applied", 114 and 122 still "applied").
BEGIN;
DO $$
DECLARE
  v_purge TEXT;
  v_admin TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_purge FROM pg_proc p WHERE p.oid = to_regprocedure('public.site_network_ip_purge(uuid,integer)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_admin FROM pg_proc p WHERE p.oid = to_regprocedure('public.purge_site_network_ips(boolean)');
  -- 53348dc9... / 8bf4c2db...: 128's bodies; 207f4845... / c0c228c4...: 078's (a second run of this rollback).
  IF v_purge IS NULL OR v_purge NOT IN ('53348dc930741ac3eae1ec3258337871', '207f4845dd9e5280fa752b7b6d69457a') THEN
    RAISE EXCEPTION '128 rollback: site_network_ip_purge (md5 %) is neither 128''s nor 078''s; stop and compare', coalesce(v_purge, 'missing');
  END IF;
  IF v_admin IS NULL OR v_admin NOT IN ('8bf4c2dbdb1b11618cabc6a1520ebd75', 'c0c228c4e802c773c1bee3885bd6caad') THEN
    RAISE EXCEPTION '128 rollback: purge_site_network_ips (md5 %) is neither 128''s nor 078''s; stop and compare', coalesce(v_admin, 'missing');
  END IF;
END
$$;

-- 078's site_network_ip_purge and purge_site_network_ips, verbatim (supabase/migrations/078_ip_retention_and_crd_numbers.sql).
CREATE OR REPLACE FUNCTION public.site_network_ip_purge(p_org UUID, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  DELETE FROM public.attendance_event_network_ips d
  WHERE d.event_id IN (SELECT i.event_id FROM public.attendance_event_network_ips i
                       WHERE i.organization_id = p_org AND i.checked_at < now() - public.site_network_ip_retention()
                       ORDER BY i.checked_at
                       LIMIT p_limit
                       FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.site_network_ip_purge(UUID, INTEGER) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.purge_site_network_ips(p_all BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.site_network_admin_org();
  v_n   INTEGER;
BEGIN
  IF p_all IS NULL THEN
    RAISE EXCEPTION 'Choose expired addresses or all of them.' USING ERRCODE = '22023', HINT = 'bad_flag';
  END IF;
  PERFORM public.time_company_lock(v_org);
  IF p_all THEN
    DELETE FROM public.attendance_event_network_ips i WHERE i.organization_id = v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    v_n := public.site_network_ip_purge(v_org, NULL);
  END IF;
  IF v_n > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_IPS_PURGED', 'attendance_event_network_ips', NULL,
      jsonb_build_object('removed', v_n, 'all', p_all, 'retention_days', 30));
  END IF;
  RETURN jsonb_build_object('removed', v_n, 'all', p_all, 'retention_days', 30);
END
$$;
REVOKE ALL ON FUNCTION public.purge_site_network_ips(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_site_network_ips(BOOLEAN) TO authenticated;

DROP FUNCTION IF EXISTS public.rename_site_network(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.record_clock_in_refusal(uuid, text);
DROP FUNCTION IF EXISTS public.clock_in_refusal_ip_purge(uuid, integer);
DROP FUNCTION IF EXISTS public.clock_in_refusal_answer(public.clock_in_network_refusals, boolean);
DROP TABLE IF EXISTS public.clock_in_network_refusals;
DELETE FROM public.site_network_ops WHERE kind = 'rename';
ALTER TABLE public.site_network_ops DROP CONSTRAINT IF EXISTS site_network_ops_kind_check;
ALTER TABLE public.site_network_ops ADD CONSTRAINT site_network_ops_kind_check CHECK (kind IN ('check', 'add', 'remove', 'member'));

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.site_network_ip_purge(uuid,integer)')) IS DISTINCT FROM '207f4845dd9e5280fa752b7b6d69457a'
     OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.purge_site_network_ips(boolean)')) IS DISTINCT FROM 'c0c228c4e802c773c1bee3885bd6caad'
     OR to_regclass('public.clock_in_network_refusals') IS NOT NULL OR to_regprocedure('public.rename_site_network(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.record_clock_in_refusal(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '128 rollback: 078''s purge functions are not back, or something of 128 is left';
  END IF;
END
$$;
COMMIT;
