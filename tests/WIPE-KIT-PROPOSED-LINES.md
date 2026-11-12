# Proposed wipe-kit lines — reviewer decision AH

**REVIEW ONLY. Nothing here was executed. No private repo was changed.** These snippets are for independent review and a disposable rehearsal, not approval to wipe. Recheck the current private kit against this reviewed table-name/action fixture before editing it. No private IDs, project details, data or secrets appear here.

The reviewer decided: keep chase settings, costing, setup progress and AI controls; wipe **JNR only** chase pauses and sends, preserving approval evidence first. Never change Marpet or another company's rows, logins, settings, numbering or earlier audit history. This replaces AC's earlier KEEP chase_sends proposal.

## 1. Nine missing tables: proposed VALUES rows

Add these inside the existing `INSERT INTO b11_list (ord, action, tbl, jnr_rows, export) VALUES`, before its final semicolon. Numbers are unused in the reviewed list. These are fragments, not standalone commands:

```sql
(89,  'WIPE', 'public.chase_sends',               'organization_id = {org}', TRUE),
(90,  'WIPE', 'public.chase_pauses',              'organization_id = {org}', TRUE),
(245, 'KEEP', 'public.chase_steps',               'organization_id = {org}', TRUE),
(247, 'KEEP', 'public.costing_materials',         'organization_id = {org}', TRUE),
(248, 'KEEP', 'public.costing_machines',          'organization_id = {org}', TRUE),
(249, 'KEEP', 'public.costing_defaults',          'organization_id = {org}', TRUE),
(250, 'KEEP', 'public.company_setup_progress',    'organization_id = {org}', TRUE),
(251, 'KEEP', 'public.ai_helper_tolra_companies', 'organization_id = {org}', TRUE),
(252, 'KEEP', 'public.ai_helper_tolra_control',   NULL, FALSE),
```

The global AI control has no organization_id and is never exported. The unknown-company-table guard alone would miss it. AI request/cost evidence and the spending/reservation ledger must not reset a real allowance: replace existing 164/165 WIPE rows, not duplicate them:

```sql
(164, 'KEEP', 'public.ai_helper_requests', 'organization_id = {org}', TRUE),
(165, 'KEEP', 'public.ai_helper_usage',    'organization_id = {org}', TRUE),
```

Keep the kit's existing auth users/members/profiles, organizations/settings, time settings, doc_counters, templates/schedules, machines/stock, connections/keys/mappings and immutable audit classifications. Existing operational business email/integration-send rows follow the original kit's classification; chase-linked messages/invoice snapshots must be archived below before any deletion. No earlier immutable audit entry is deleted.

## 2. Proposed protected archive: separate preparation and review

This new table has **no FK into invoices, email_history, chase_sends or another wiped table**. It keeps original IDs/text in the evidence JSON. The sole company FK points to kept organizations. Reviewer must approve/archive DDL separately; do not silently create it in a live wipe. This proposal does not assign or apply a migration.

```sql
CREATE TABLE security_audit.chase_approval_evidence (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  chase_send_id uuid NOT NULL,
  evidence jsonb NOT NULL,
  evidence_sha256 text NOT NULL CHECK (
    evidence_sha256 = encode(extensions.digest(
      convert_to(public.canonical_jsonb(evidence), 'UTF8'), 'sha256'), 'hex')
  ),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, chase_send_id)
);
ALTER TABLE security_audit.chase_approval_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.chase_approval_evidence FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION security_audit.chase_approval_evidence_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $archive_guard$
BEGIN
  RAISE EXCEPTION 'Chase approval evidence is immutable';
END;
$archive_guard$;
REVOKE ALL ON FUNCTION security_audit.chase_approval_evidence_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER chase_approval_evidence_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON security_audit.chase_approval_evidence
FOR EACH STATEMENT EXECUTE FUNCTION security_audit.chase_approval_evidence_immutable();
```

Register this additional proposed archive as KEEP in the same one-list file (beyond the nine missing tables), so driver/export/check fingerprints cover it. Do not export message contents automatically:

```sql
(253, 'KEEP', 'security_audit.chase_approval_evidence', 'organization_id = {org}', FALSE),
```

No trigger on this archive is added to the wipe's disable list. Access stays owner-only; no browser SELECT/write policy is introduced. Earlier stored evidence can never be overwritten to make verification pass.

## 3. Archive and verify before protected fingerprints or any delete

Insert the following proposed block **inside the existing wipe transaction, after its verified JNR/project/disconnect/unknown-table/FK checks and table locks, but before section 2 captures protected fingerprints**. The existing c_jnr is its verified JNR constant, not a new argument. Because the archive is KEEP, its newly preserved rows must be captured in the protected baseline after this block, then remain unchanged through deletion. The normal dry mode rolls back the archive and audit appends too.

```sql
DECLARE
  c_jnr uuid := (SELECT org_txt::uuid FROM b11_cfg);
  r record;
  v_inserted integer;
BEGIN
  IF to_regclass('security_audit.chase_approval_evidence') IS NULL THEN
    RAISE EXCEPTION 'REFUSED: reviewed approval evidence archive is missing. Nothing changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.chase_sends s
    LEFT JOIN public.invoices i ON i.id = s.invoice_id AND i.organization_id = s.organization_id
    LEFT JOIN public.email_history d ON d.id = s.draft_history_id AND d.organization_id = s.organization_id
    LEFT JOIN public.email_history e ON e.id = s.sent_history_id AND e.organization_id = s.organization_id
    WHERE s.organization_id = c_jnr AND (
      i.id IS NULL OR
      (s.status = 'sent' AND (s.sent_history_id IS NULL OR e.id IS NULL)) OR
      (s.status = 'drafted' AND (s.draft_history_id IS NULL OR d.id IS NULL)) OR
      (s.draft_history_id IS NOT NULL AND d.id IS NULL) OR
      (s.sent_history_id IS NOT NULL AND e.id IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'REFUSED: incomplete or cross-company chase evidence; review before wiping. Nothing changed.';
  END IF;
  FOR r IN
    SELECT s.organization_id, s.id,
      jsonb_build_object('chase_send', to_jsonb(s), 'invoice', to_jsonb(i),
                         'draft_email', to_jsonb(d), 'sent_email', to_jsonb(e)) AS evidence
    FROM public.chase_sends s
    JOIN public.invoices i ON i.id = s.invoice_id AND i.organization_id = s.organization_id
    LEFT JOIN public.email_history d ON d.id = s.draft_history_id AND d.organization_id = s.organization_id
    LEFT JOIN public.email_history e ON e.id = s.sent_history_id AND e.organization_id = s.organization_id
    WHERE s.organization_id = c_jnr
    ORDER BY s.id
  LOOP
    INSERT INTO security_audit.chase_approval_evidence
      (organization_id, chase_send_id, evidence, evidence_sha256)
    VALUES (r.organization_id, r.id, r.evidence,
      encode(extensions.digest(convert_to(public.canonical_jsonb(r.evidence), 'UTF8'), 'sha256'), 'hex'))
    ON CONFLICT (organization_id, chase_send_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF NOT EXISTS (
      SELECT 1 FROM security_audit.chase_approval_evidence a
      WHERE a.organization_id = r.organization_id AND a.chase_send_id = r.id
        AND a.evidence = r.evidence
        AND a.evidence_sha256 = encode(extensions.digest(
          convert_to(public.canonical_jsonb(r.evidence), 'UTF8'), 'sha256'), 'hex')
    ) THEN
      RAISE EXCEPTION 'REFUSED: archived approval evidence differs. Nothing changed.';
    END IF;
    IF v_inserted = 1 THEN
      PERFORM security_audit.log_named_event(r.organization_id, 'CHASE_EVIDENCE_ARCHIVED',
        'chase_sends', r.id::text, jsonb_build_object('evidence_sha256',
          encode(extensions.digest(convert_to(public.canonical_jsonb(r.evidence), 'UTF8'), 'sha256'), 'hex')));
    END IF;
  END LOOP;
END;
```

This is a nested DECLARE/BEGIN/END block for the driver's existing DO body, not standalone SQL or another DO statement. It belongs in the **same already-open wipe transaction**. Its local c_jnr reads only the already identity-checked b11_cfg; never run it before the driver's hard-coded JNR identity checks. No COMMIT is added. Existing locks must include the KEEP archive and all chase/invoice/email source tables, preventing changes between preservation and deletion. An absent chase schema is a refusal requiring explicit review, not a reason to bypass this block.

Safe deletion order after preservation and fingerprint capture: chase_sends (89) → chase_pauses (90) → the existing invoice/customer/email parent sequence. No FK is disabled or link nulled. Exact approved subject/body, recipient, approval IDs/times, send state (including uncertain draft state), original send/invoice IDs and invoice snapshot live in the immutable archive; the append-only audit chain records its digest. Every source row must match its archive before the driver may delete anything. A mismatch/partial archive aborts the entire transaction.

## 4. JNR-only disconnect check for all accounting providers

Replace the Xero-only predicate in the driver's existing preflight and companion check with:

```sql
EXISTS (
  SELECT 1 FROM public.integration_connections
  WHERE organization_id = c_jnr
    AND provider IN ('xero', 'sage', 'quickbooks')
    AND status IS DISTINCT FROM 'disconnected'
)
```

Its refusal branch says disconnect JNR's Xero/Sage/QuickBooks first. Do not delete tokens to force it to pass. Keep Microsoft rows but stop mailbox polling/writers for rehearsal. Keep original project/company verification, locks, unknown-table/KEEP→WIPE guards, trigger restoration, earlier-audit hashes and all-other-company fingerprints. Marpet rows are never in either archive or delete scope.

## 5. Review and proof still required

The public `tests/fixtures/wipe-kit/reviewed-table-list.json` contains sanitized ord/action/table names from Y, not private data. The unit parser applies these proposed list rows to that reviewed list and rejects duplicate ordinals, changed kept-table classifications, wrong new-table actions, unscoped WIPE rows and bad send-before-parent ordering. It also checks the archive-preserve/verify design. These are static proofs, not database execution.

No private repo touched, SQL applied, archive created, wipe run, connection opened or deploy performed. The reviewer must separately prove archive DDL/permissions/immutability, full evidence equality/digests, inserted audit chain, dry rollback, failed/partial archive rollback, safe FK deletion, and unchanged Marpet/settings/logins/numbering/history on a disposable restored copy before any live decision. Refresh the current kit/table list and reviewed hashes first.
