-- =====================================================================================================
-- 077: the audit chain's previous-hash lookup served by an index. Applied after 075. Independent of 076 (data import): either order.
--
-- PROBLEM. security_audit.set_audit_hash() (006; BEFORE INSERT on security_audit.audit_log, every audit row) picks the previous row of
-- the company's chain with
--     WHERE organization_id IS NOT DISTINCT FROM NEW.organization_id ORDER BY created_at DESC LIMIT 1
-- IS NOT DISTINCT FROM can't be an index condition, so every audit row read the WHOLE audit_log (all companies) and sorted it: a
-- sequential scan per row. Imports and every audited write get slower as the log grows.
--
-- WHAT CHANGES. Only the lookup, split by the one thing IS NOT DISTINCT FROM was there for:
--     NEW.organization_id IS NULL : WHERE organization_id IS NULL                 ORDER BY organization_id, created_at DESC LIMIT 1
--     otherwise                   : WHERE organization_id = NEW.organization_id   ORDER BY organization_id, created_at DESC LIMIT 1
-- Both are the same set of rows as before (for a non-null uuid, IS NOT DISTINCT FROM is =; for NULL it is IS NULL) in the same order
-- (organization_id is one value within the set, so ordering by it first changes nothing; it is there so the NULL branch's ORDER BY
-- matches the index exactly). Each is a single descent of the index audit_log_org_created_idx (organization_id, created_at DESC)
-- and stops at the first entry.
--
-- WHAT DOES NOT CHANGE (checked by supabase/verify/audit_hash_077.sql and tests/db/audit-chain-077.test.ts):
--   * the lock: the same pg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT, ''))) as the first statement, held to the
--     end of the transaction (050's time_company_lock and every lock order that names "the audit-chain lock" rely on that key);
--   * created_at := clock_timestamp() before the lookup; the hash text, field by field; SECURITY DEFINER; the pinned search_path; the
--     owner and the grants (CREATE OR REPLACE keeps them); the trigger audit_log_set_hash itself is not touched;
--   * which row is "previous": the row with the latest created_at among the company's rows the statement can see (the same snapshot
--     rules: a new snapshot per statement under READ COMMITTED, the transaction's under REPEATABLE READ). Ties (two rows of one company
--     with the same created_at, which clock_timestamp() under the company lock makes all but impossible): 006's plan is a sequential scan
--     into a bounded sort that keeps the FIRST tied row it reads, i.e. the lowest physical position (ctid); the index keeps equal keys in
--     ctid order, so a forward scan also returns the lowest ctid. Same row. (006 is only that deterministic when the scan starts at
--     block 0: on a table larger than a quarter of shared_buffers a synchronised scan may start mid-table. 077 always gives the lowest.)
--   * existing rows: none is read for writing, updated, rehashed or recomputed. Nothing here writes to audit_log (the append-only
--     trigger would refuse it anyway).
--
-- THE INDEX. audit_log_org_created_idx (organization_id, created_at DESC) has existed since 000 (applied on production); 006's lookup
-- just couldn't use it. 077 does NOT add a second index: a duplicate would add a write to every audit row, the cost this fixes. It runs
-- CREATE INDEX IF NOT EXISTS (a no-op where 000 ran) and then refuses to go on unless the index is exactly that definition, valid and
-- ready (an ASCENDING created_at index would order equal keys the other way on a backward scan, and an INVALID index left by a failed
-- CONCURRENTLY build would be skipped by IF NOT EXISTS). Release preflight row 12 shows beforehand whether it is there.
-- Not CONCURRENTLY: the release text is one transaction (scripts/release-sql.mjs refuses CONCURRENTLY, which can't run inside one).
-- If the index were ever missing, this plain build takes a SHARE lock on audit_log for the build (audit inserts, i.e. every audited
-- write, wait; reads don't); RELEASE.md "077" has the measured time and the CONCURRENTLY route to run first if that is too long.
--
-- GUARD. 077 replaces set_audit_hash only if it is 006's (compared without whitespace, so CRLF bodies from the SQL editor match) or
-- 077's own (a second run). Anything else stops the release: a different chain function on the database must be looked at first.
-- SELF-CHECK (section 5, before COMMIT): on the live data, 006's lookup and 077's pick the same row for every company and the NULL
-- chain; any difference stops the release and nothing of 077 is kept.
-- Rollback: supabase/release/077_audit_hash_index_lookup.rollback.sql (006's function back, byte for byte; no row is touched).
-- =====================================================================================================

-- 1. The guard: the function being replaced is 006's (or already 077's), on 006's trigger.
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT regexp_replace(p.prosrc, '\s', '', 'g') INTO v_src
  FROM pg_proc p WHERE p.oid = to_regprocedure('security_audit.set_audit_hash()');
  -- f52ea7c6...: 006's body; 5f4b0bce...: this file's body (section 3); both with every whitespace character removed.
  IF v_src IS NULL OR md5(v_src) NOT IN ('f52ea7c6a9b6178d866b73e7a84d784e', '5f4b0bcedcdf8a8c044e2e78a88a7221') THEN
    RAISE EXCEPTION '077: security_audit.set_audit_hash() is not 006''s chain function (md5 without whitespace %); stop and compare it first',
      coalesce(md5(v_src), 'missing');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'security_audit.audit_log'::regclass AND t.tgname = 'audit_log_set_hash' AND t.tgenabled = 'O'
      AND t.tgfoid = 'security_audit.set_audit_hash()'::regprocedure
      AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER audit_log_set_hash BEFORE INSERT ON security_audit.audit_log FOR EACH ROW EXECUTE FUNCTION security_audit.set_audit_hash()') THEN
    RAISE EXCEPTION '077: the audit_log_set_hash trigger is not the BEFORE INSERT FOR EACH ROW trigger 006 relies on';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The index the lookup uses (exists since 000: a no-op there; see THE INDEX above).
CREATE INDEX IF NOT EXISTS audit_log_org_created_idx ON security_audit.audit_log (organization_id, created_at DESC);

-- -----------------------------------------------------------------------------------------------------
-- 3. The chain function: 006's, with only the lookup changed. Same lock, same order of steps, same hash.
CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, security_audit
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT, '')));

  NEW.created_at := clock_timestamp();

  -- 077: the same row as 006's "organization_id IS NOT DISTINCT FROM NEW.organization_id ORDER BY created_at DESC LIMIT 1", read
  -- through audit_log_org_created_idx (organization_id, created_at DESC) instead of a scan and sort of the whole log.
  IF NEW.organization_id IS NULL THEN
    SELECT hash
    INTO previous
    FROM security_audit.audit_log
    WHERE organization_id IS NULL
    ORDER BY organization_id, created_at DESC
    LIMIT 1;
  ELSE
    SELECT hash
    INTO previous
    FROM security_audit.audit_log
    WHERE organization_id = NEW.organization_id
    ORDER BY organization_id, created_at DESC
    LIMIT 1;
  END IF;

  NEW.previous_hash := previous;
  NEW.hash := encode(
    digest(
      coalesce(previous, '') ||
      coalesce(NEW.organization_id::TEXT, '') ||
      coalesce(NEW.actor_user_id::TEXT, '') ||
      NEW.action ||
      NEW.entity_table ||
      coalesce(NEW.entity_id, '') ||
      coalesce(NEW.old_data::TEXT, '') ||
      coalesce(NEW.new_data::TEXT, '') ||
      coalesce(NEW.metadata::TEXT, '') ||
      NEW.created_at::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------------------------------
-- 4. The index is exactly the one the lookup needs: (organization_id, created_at DESC), valid and ready.
DO $$
DECLARE
  v_idx OID := to_regclass('security_audit.audit_log_org_created_idx');
BEGIN
  IF v_idx IS NULL
     OR pg_get_indexdef(v_idx) <> 'CREATE INDEX audit_log_org_created_idx ON security_audit.audit_log USING btree (organization_id, created_at DESC)'
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = v_idx AND i.indisvalid AND i.indisready AND i.indislive) THEN
    RAISE EXCEPTION '077: security_audit.audit_log_org_created_idx is not the valid (organization_id, created_at DESC) btree index: %',
      coalesce(pg_get_indexdef(v_idx), 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 5. On this database, now: for every company and the NULL chain, 006's lookup and 077's pick the same row (read only; one scan of
--    the log per company, once, at release time). Otherwise the release stops and nothing of 077 is kept.
DO $$
DECLARE
  v_org RECORD;
  v_006 TEXT;
  v_077 TEXT;
BEGIN
  FOR v_org IN SELECT o.id FROM public.organizations o UNION ALL SELECT NULL::UUID LOOP
    -- One statement, so both lookups read the same snapshot: a live audit write between them cannot stop the release.
    SELECT
      (SELECT a.hash FROM security_audit.audit_log a
       WHERE a.organization_id IS NOT DISTINCT FROM v_org.id ORDER BY a.created_at DESC LIMIT 1),
      CASE WHEN v_org.id IS NULL
        THEN (SELECT a.hash FROM security_audit.audit_log a WHERE a.organization_id IS NULL ORDER BY a.organization_id, a.created_at DESC LIMIT 1)
        ELSE (SELECT a.hash FROM security_audit.audit_log a WHERE a.organization_id = v_org.id ORDER BY a.organization_id, a.created_at DESC LIMIT 1)
      END
    INTO v_006, v_077;
    IF v_006 IS DISTINCT FROM v_077 THEN
      RAISE EXCEPTION '077: company % would chain to % under 006 but % under 077', coalesce(v_org.id::TEXT, 'NULL'), v_006, v_077;
    END IF;
  END LOOP;
END
$$;
