# Proposed wipe-kit lines : reviewer decision AH

**Reviewer verdict: NOT SAFE.** The real combined wipe kit has not been proved by these fragments, parser tests or temporary-source SQL harness. Code is doing a separate throwaway rehearsal. No live wipe, SQL or release is approved. Use the numbered combined-kit checklist below to record results.

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
      convert_to(evidence::text, 'UTF8'), 'sha256'), 'hex')
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
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(name)
    WHERE has_table_privilege(name, 'security_audit.chase_approval_evidence', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='security_audit.chase_approval_evidence'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='security_audit.chase_approval_evidence'::regclass
      AND tgname='chase_approval_evidence_immutable' AND tgenabled='O'
      AND tgfoid='security_audit.chase_approval_evidence_immutable()'::regprocedure) THEN
    RAISE EXCEPTION 'REFUSED: archive permissions or append-only guard differ. Nothing changed.';
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
      encode(extensions.digest(convert_to(r.evidence::text, 'UTF8'), 'sha256'), 'hex'))
    ON CONFLICT (organization_id, chase_send_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF NOT EXISTS (
      SELECT 1 FROM security_audit.chase_approval_evidence a
      WHERE a.organization_id = r.organization_id AND a.chase_send_id = r.id
        AND a.evidence = r.evidence
        AND a.evidence_sha256 = encode(extensions.digest(
          convert_to(r.evidence::text, 'UTF8'), 'sha256'), 'hex')
    ) THEN
      RAISE EXCEPTION 'REFUSED: archived approval evidence differs. Nothing changed.';
    END IF;
    IF v_inserted = 1 THEN
      PERFORM security_audit.log_named_event(r.organization_id, 'CHASE_EVIDENCE_ARCHIVED',
        'chase_sends', r.id::text, jsonb_build_object('evidence_sha256',
          encode(extensions.digest(convert_to(r.evidence::text, 'UTF8'), 'sha256'), 'hex')));
    END IF;
  END LOOP;
  -- Count and compare the whole source again under the driver's retained locks.
  IF (SELECT count(*) FROM public.chase_sends WHERE organization_id=c_jnr) <>
     (SELECT count(*) FROM public.chase_sends s JOIN security_audit.chase_approval_evidence a
       ON a.organization_id=s.organization_id AND a.chase_send_id=s.id WHERE s.organization_id=c_jnr)
     OR EXISTS (
       SELECT 1 FROM public.chase_sends s
       LEFT JOIN public.invoices i ON i.id=s.invoice_id AND i.organization_id=s.organization_id
       LEFT JOIN public.email_history d ON d.id=s.draft_history_id AND d.organization_id=s.organization_id
       LEFT JOIN public.email_history e ON e.id=s.sent_history_id AND e.organization_id=s.organization_id
       LEFT JOIN security_audit.chase_approval_evidence a ON a.organization_id=s.organization_id AND a.chase_send_id=s.id
       WHERE s.organization_id=c_jnr AND (i.id IS NULL OR a.chase_send_id IS NULL OR a.evidence IS DISTINCT FROM
         jsonb_build_object('chase_send',to_jsonb(s),'invoice',to_jsonb(i),'draft_email',to_jsonb(d),'sent_email',to_jsonb(e))))
  THEN RAISE EXCEPTION 'REFUSED: approval archive incomplete. Nothing changed.';
  END IF;
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

AH follow-up assumption: digest the stored JSONB text on the same PostgreSQL engine used for verification. Do not call the job-signoff canonicalizer: it rejects numeric JSON, while invoice and send snapshots contain numbers. Equality of the full JSONB evidence is checked independently of its digest. Cross-version restores must verify both equality and digests before any deletion. The reviewed list is a sanitized public fixture, not a fresh read of the private repo.


## 6. Runnable review proofs, not executed here

`tests/db/wipe-archive-review.test.ts` requires the separately reviewed archive DDL and required KEEP schemas already prepared on an identity-verified disposable database. It never installs the archive. Named tests cover API-role permissions, owner append-only refusal, missing invoice, changed approval evidence, suppressed/incomplete copy, atomic rollback, and two-company before/after protection of settings, numbering, logins and old audit history. The SQL harness executes this exact proposed block with only its three source relation names redirected to temporary twins. This permits missing-invoice fixtures without disabling real foreign keys. The archive and permission/immutability checks use the real protected table.

The harness is not the private driver's full wipe: it deletes only synthetic JNR source rows in its temporary tables after verifying the copy. Real source-FK deletion, private driver fingerprints and a restored-copy rehearsal remain separate required proofs. No private repository was read or changed in this follow-up. Missing schemas/credentials must fail the proof, not skip it. These database tests are NOT RUN under the no-SQL rule.


## 7. AN: numbered checklist for Code's real combined-kit throwaway rehearsal

**Every item starts NOT RUN. #250 stays NOT SAFE until the real combined kit passes and its reviewer conditions are cleared.** Run only on Code's separately authorised disposable restored copy. The actual combined driver's dry and apply paths, reviewed table list, archive and companion check must be the ones being assessed, not a stand-alone snippet or the temporary source twins. Do not change the private repo from this task. Keep private snapshots, account details, keys and evidence contents out of the public PR; paste only redacted result summaries and safe evidence references here.

Rehearsal code/kit revisions: ____  Reviewed table-list digest: ____  Disposable-copy identity: ____  Backup/restore evidence: ____  Code/tester and date: ____

1. [ ] **CW-01: Pin the real combined inputs and identity.** Record the exact driver, proposed additions, companion check, schema and table-list versions. Independently identify JNR and Marpet in the disposable copy. Confirm the kit refuses a wrong project/company, a hosted/live target, an unknown table or an unreviewed classification. A missing prerequisite must stop the whole operation before writes. Result: NOT RUN. Actual result / evidence / tester / date: ____

2. [ ] **CW-02: Prove the exact KEEP/WIPE decisions.** KEEP chase_steps, costing_materials, costing_machines, costing_defaults, company_setup_progress, ai_helper_tolra_companies and global ai_helper_tolra_control. Among these additions WIPE only JNR chase_pauses and chase_sends. Preserve existing protected classifications, AI request/usage history and the archive. Refuse duplicate/missing list entries, global-control export, an unscoped predicate or any other-company delete target. Result: NOT RUN. Actual result / evidence / tester / date: ____

3. [ ] **CW-03: Capture the BEFORE baseline from both companies.** Before archiving or deletion, capture row counts plus deterministic full-row comparisons/digests for every protected table. Retain the exact row/ID sets needed to detect both missing and changed rows; counts alone are insufficient. Include Marpet's business rows and every category in CW-04 to CW-07. Store evidence privately, without dumping credentials in logs. Result: NOT RUN. Actual result / evidence / tester / date: ____

4. [ ] **CW-04: Marpet comparison, BEFORE and AFTER.** Compare every Marpet row and relationship in the real combined table inventory, including business records, chase rows, integrations and archive scope. Require exact equality, not only a count or a sample. A missing/changed Marpet row must fail the rehearsal and refuse completion. No Marpet record may enter the JNR archive/delete scope. Result: NOT RUN. Actual result / evidence / tester / date: ____

5. [ ] **CW-05: Login comparison, BEFORE and AFTER.** Compare JNR and Marpet auth users, profiles, memberships, roles/access, sessions and the existing kit's other kept login/security rows. No login is removed, reassigned, reset or changed. Verify values/relationships privately and publish no passwords, tokens or credential hashes. Any missing or differing kept login row is a failure. Result: NOT RUN. Actual result / evidence / tester / date: ____

6. [ ] **CW-06: Settings comparison, BEFORE and AFTER.** Compare both companies' settings, hours/breaks, branding, users/roles settings, templates/schedules, connections/mappings and all seven reviewer KEEP tables. Compare the global Tolra control privately without exporting its saved key. No setting or saved control may be reset to make the wipe pass. Missing or changed protected settings must refuse completion. Result: NOT RUN. Actual result / evidence / tester / date: ____

7. [ ] **CW-07: Numbering and audit comparison, BEFORE and AFTER.** Compare both companies' document counters, every prefix/last value and other kept numbering rows exactly. Do not reset/reseed numbering. Compare all prior audit IDs, full records and chain/digests; no old event may disappear or change. Separately account for only the explicitly expected new archive/wipe audit appends, including company and digest, rather than hiding differences in a changed total count. Result: NOT RUN. Actual result / evidence / tester / date: ____

8. [ ] **CW-08: Stop writers and retain real locks.** Prove background/mail/import writers are stopped and the reviewed locks cover every invoice/send/email source, archive and protected comparison target throughout capture, copy, verification and deletion. Attempt the concurrency/fault case and show it cannot change a source between verified copy and delete. The archive and deletes belong to one outer transaction, with no intermediate commit or swallowed refusal. Result: NOT RUN. Actual result / evidence / tester / date: ____

9. [ ] **CW-09: JNR-only disconnect check for all three providers.** Test Xero, Sage and QuickBooks separately: a JNR connected, unknown/null or other non-disconnected state refuses before any write; JNR disconnected passes that prerequisite. A connected Marpet provider must stay connected and unchanged, without being treated as a JNR connection. Never delete tokens to force the check green. Keep Microsoft settings while stopping its pollers. Result: NOT RUN. Actual result / evidence / tester / date: ____

10. [ ] **CW-10: Real safe archive shape and locked access.** Verify the reviewed security_audit archive exists, has its scoped unique key and RLS, and has no FK to wiped invoices, sends or emails. Its only company FK must reference kept organizations. Verify the immutable guard is enabled and is never on the wipe driver's disable list. An absent/unreviewed archive, wrong constraint or unsafe privilege must refuse before writes. Result: NOT RUN. Actual result / evidence / tester / date: ____

11. [ ] **CW-11: Permission and append-only tests on the real archive.** As anon, authenticated and service_role attempt read, insert, update, delete and truncate; all must refuse under the reviewed owner-only design. Show the trusted archive owner can append a new complete valid record, but update/delete/truncate of existing evidence refuses. Check rows and permissions again afterwards. No browser read/write policy or overwrite workaround is allowed. Result: NOT RUN. Actual result / evidence / tester / date: ____

12. [ ] **CW-12: Missing-source refusal before deleting anything.** In separate throwaway fault cases present a missing JNR invoice, missing referenced draft/sent message, cross-company invoice/message link and an unavailable source/archive/table-list prerequisite. Every case must refuse the entire real combined operation. Verify no source delete, partial archive or unexpected audit append survives the rollback. Never silently skip a missing invoice or weaken an FK to make the fixture work. Result: NOT RUN. Actual result / evidence / tester / date: ____

13. [ ] **CW-13: Preserve and verify every exact approval row.** On the real source tables archive every JNR chase send, its original invoice snapshot and linked draft/sent evidence before deleting invoices. Verify full JSON equality, digest and complete source-ID cardinality, including recipient, subject, body/line breaks, approver IDs/times, send state, invoice IDs and original totals. Show that no row was silently omitted by a join. Result: NOT RUN. Actual result / evidence / tester / date: ____

14. [ ] **CW-14: Differing approval or incomplete archive refuses the whole operation.** Use separately prepared fault cases for different approval text/recipient/actor/time, wrong invoice snapshot, bad digest, existing conflicting archive row and a suppressed/missing copy. Every mismatch or incomplete set must abort before any delete; compare the full pre-operation source/archive/audit state after rollback. Never overwrite old evidence or catch an exception and continue wiping. Result: NOT RUN. Actual result / evidence / tester / date: ____

15. [ ] **CW-15: Capture protected archive baseline, then prove real FK-safe order.** Only after CW-13 succeeds, include the verified archive/new approved audit appends in the protected baseline. The real driver must delete JNR chase_sends then chase_pauses before invoice/email/customer parents. Exercise the actual source FKs and reviewed driver trigger handling. Do not disable FKs, null evidence links, cascade into kept data or disable archive immutability to obtain success. A temporary-source harness cannot tick this row. Result: NOT RUN. Actual result / evidence / tester / date: ____

16. [ ] **CW-16: Dry mode rolls back the complete real operation.** Run the combined driver's normal dry path, including archive, verification, audit append and deletes. Compare the complete BEFORE state afterwards for both companies, protected rows, source rows, numbering, old audit and archive. Require exact restoration. A missing row or any unexplained change fails. Result: NOT RUN. Actual result / evidence / tester / date: ____

17. [ ] **CW-17: Throwaway apply path and AFTER comparison.** Only under Code's separate throwaway authorisation, exercise the real apply path. Compare against CW-03 to CW-07 and the post-copy protected baseline: only explicitly reviewed JNR operational rows may be removed. Marpet, logins, settings, numbering, old audit and every KEEP row must match exactly. Unexpected removal/change must produce a failed result and stop acceptance, not a warning or skip. Result: NOT RUN. Actual result / evidence / tester / date: ____

18. [ ] **CW-18: Evidence survives invoice deletion and review remains separate.** As the permitted archive reader verify every saved approval/invoice record and digest after the real invoice delete, with original IDs/text intact. Repeat API denial checks. Paste actual counts, mismatch/refusal outcomes and safe evidence references against every checklist row. Code/reviewer must resolve all failed/NOT RUN items; this checklist and any green subset are not release, SQL, wipe or go-live approval. Result: NOT RUN. Actual result / evidence / tester / date: ____

Final tick list:

- [x] AN: numbered must-fix checks written for the real combined kit; documentation/parser checks only.
- [ ] Code: real combined-kit throwaway results entered and independently reviewed; #250 remains NOT SAFE meanwhile.
- [ ] Any live action: requires its own explicit approval, outside this document.
