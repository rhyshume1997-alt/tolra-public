# Proposed wipe-kit lines — AC

**REVIEW ONLY. Do not run these snippets. Nothing was changed in the private repository and no SQL was executed.**

These are proposed edits to the kit reviewed in Y, not an approved replacement kit. The source is the requested private branch's `28-wipe-jnr-tables.sql` and `28-wipe-jnr.sql`; only public-schema names and proposed logic are reproduced here. No company IDs, project IDs, connection details or secrets are copied. Recheck the current private kit before editing it.

Assumption: “keep audit history” includes chase approvals and send evidence. That is the safest reading. It deliberately leaves a retention blocker rather than deleting that history to make a wipe pass.

## 1. Add the nine missing tables to the single list

The driver, export and check scripts all read `28-wipe-jnr-tables.sql`. Add these **VALUES rows** inside its existing `INSERT INTO b11_list (ord, action, tbl, jnr_rows, export) VALUES`, before the final semicolon. These numbers were unused in the reviewed list. They are fragments, not standalone runnable SQL:

```sql
(90,  'WIPE', 'public.chase_pauses',              'organization_id = {org}', TRUE),
(245, 'KEEP', 'public.chase_steps',               'organization_id = {org}', TRUE),
(246, 'KEEP', 'public.chase_sends',               'organization_id = {org}', TRUE),
(247, 'KEEP', 'public.costing_materials',         'organization_id = {org}', TRUE),
(248, 'KEEP', 'public.costing_machines',          'organization_id = {org}', TRUE),
(249, 'KEEP', 'public.costing_defaults',          'organization_id = {org}', TRUE),
(250, 'KEEP', 'public.company_setup_progress',    'organization_id = {org}', TRUE),
(251, 'KEEP', 'public.ai_helper_tolra_companies', 'organization_id = {org}', TRUE),
(252, 'KEEP', 'public.ai_helper_tolra_control',   NULL, FALSE),
```

| Table | Reason |
| --- | --- |
| chase_pauses | Operational pause on JNR's invoice/customer. If deletion is ever approved, remove before those parents; other companies untouched. |
| chase_steps | Company chase settings, kept. |
| chase_sends | Approval/send evidence and duplicate-send history, kept. FK blocker below must not be bypassed. |
| costing_materials / costing_machines / costing_defaults | Company rates and costing settings, kept. |
| company_setup_progress | Company setup ticks, kept; ordinary staff/support must not gain access. |
| ai_helper_tolra_companies | Company mode and owner-set cap, kept. |
| ai_helper_tolra_control | Global control and encrypted key, kept for everyone and NEVER exported. It has no organization_id, so the old unknown-company-table guard would not discover it. |

## 2. Keep AI evidence and usage instead of resetting a cap

Replace the existing 164/165 WIPE rows with these KEEP rows; do not leave both versions in the list:

```sql
(164, 'KEEP', 'public.ai_helper_requests', 'organization_id = {org}', TRUE),
(165, 'KEEP', 'public.ai_helper_usage',    'organization_id = {org}', TRUE),
```

Requests record decisions/cost evidence. Usage includes reserved/spent money; deleting it can reset a company's monthly allowance accounting. Keep existing `ai_helper_settings`, `ai_helper_secrets` and the new cap/control rows too. Never export secret tables.

Under the preservation-first reading, also replace the existing operational send-history WIPE rows below with KEEP, rather than silently losing the exact text and send evidence:

```sql
(101, 'KEEP', 'public.integration_sends', 'organization_id = {org}', TRUE),
(145, 'KEEP', 'public.email_history',     'organization_id = {org}', TRUE),
```

These classifications can expose further kept-child/wiped-parent links. That is a refusal requiring retention review, not a reason to switch off the guard. This report does not authorize deletion of any audit/history table elsewhere in the kit.

## 3. Chase approval FK blocker: refuse before any delete

`chase_sends.invoice_id` is NOT NULL and has `ON DELETE CASCADE` to invoices. Its history IDs use `ON DELETE SET NULL` to email_history. Deleting an invoice first deletes its approval rows; deleting the approval rows first loses history. Deleting email history can change kept approval evidence. **No delete order alone preserves these rows while removing their parents.**

Proposed explanatory guard in the existing driver's DO block, after company identity checks/locks and before the first DELETE or trigger-disable loop. `c_jnr` is the driver's existing verified JNR constant; no new unverified company ID is introduced:

```sql
IF to_regclass('public.chase_sends') IS NOT NULL THEN
  IF EXISTS (
    SELECT 1 FROM public.chase_sends
    WHERE organization_id = c_jnr
  ) THEN
    RAISE EXCEPTION
      'REFUSED: JNR chase approval/send history must be retained; review invoice/email retention before wiping. Nothing changed.';
  END IF;
END IF;
```

Keep the existing **KEEP-table foreign-key-to-WIPE-table refusal**, even when there are no approval rows: it still detects the structural cascade risk. Do not add a DELETE on chase_sends, disable FK triggers, change the list to dodge the guard, use CASCADE, or update away the invoice/history links.

Safe sequence for the reviewer:

1. Confirm the same verified JNR identity/project; quiesce writers, senders, mail polling and accounting jobs. Capture the restored-copy baseline and backup/restore evidence.
2. Classify every table and capture all protected rows. Run the added history guard and the existing unknown-table/KEEP-FK guards **before any delete**. With the present FK design, stop here.
3. A separately reviewed design must either retain the required invoice/email parent rows, or preserve approvals in an approved immutable archive with a proven audit chain. Neither schema change nor archive SQL is invented in this proposal. Review its effects on every other FK before approving a wipe.
4. Only after that separate design is proven on the disposable restore can an approved operational wipe use children before parents: JNR chase pauses (90) before invoice/customer rows; opening_wip (existing 134) before jobs; other original child ordering remains. Approval history stays retained. Numbering/logins/settings never reset.
5. Verify protected fingerprints, every earlier audit row, enabled triggers and every Marpet/other-company row; then test dry rollback and a separately approved commit rehearsal. Do not treat this document as either approval.

## 4. Refuse all accounting connections, not Xero alone

Replace the existing driver's Xero-only connected predicate with the following condition inside its existing refusal branch. Use the same condition in the companion check/preflight logic:

```sql
EXISTS (
  SELECT 1 FROM public.integration_connections
  WHERE organization_id = c_jnr
    AND provider IN ('xero', 'sage', 'quickbooks')
    AND status IS DISTINCT FROM 'disconnected'
)
```

Suggested refusal text:

```sql
RAISE EXCEPTION
  'REFUSED: disconnect JNR accounting connections (Xero, Sage and QuickBooks) before wiping. Nothing changed.';
```

Keep the rows, encrypted tokens, settings and mappings as classified KEEP; do not delete credentials to force this check to pass. Disconnect through the reviewed app flow before capturing the baseline. Stop reconnects/jobs while rehearsing. Microsoft mailbox writes also need quiescing even though this predicate concerns accounting providers.

## 5. Already covered: do not add duplicate rows

- 138 also adds invoice claim fields and template keys: existing invoices and email_templates rows cover them. email_history needs the retention replacement above.
- 140 source_ref: invoices, quotes, purchase_orders, jobs, sales_orders are already listed. No new table.
- 141 opening_wip: already listed before jobs. Do not duplicate it.
- 142 weekdays: email_schedules already KEEP. No new table.
- 143: the three costing tables are the new KEEP rows above.
- 144: no new accounting_connections table. Existing integration_connections, integration_secrets, integration_oauth_states and integration_sends hold the accounting data. Keep connections/secrets and non-invite states; existing invite-state cleanup needs its original scoped review. Mappings/app credentials/contact mappings already have classifications. The provider disconnect guard needs extending as above.
- N5 and N2/cap: use the three new progress/mode/global-control rows plus existing AI settings/request/usage storage described above. In #247 they are post-144 release phases 145 and 146, not baseline migrations; the keeper classifications apply whichever approved packaging installs them.

## Never wipe

Keep auth users/logins, organization memberships/profiles, company settings/branding/hours/break choices, setup progress, templates/schedules, rates, keys/connections/mappings, document counters/numbering, AI controls/caps/usage, approval/send history and all existing audit history. The existing `security_audit.audit_log` remains APPEND only: old entries unchanged, newly audited approved actions may append. Never alter a Marpet row or any other company's row.

Retain the kit's exact-company/project checks, unknown-table guard, table locks, immutable-history checks, trigger restoration checks and protected-row fingerprints. Do not broaden its organization predicate. Export no encrypted credentials or keys. The same list must drive export, dry run, checks and any separately approved execution.

## Evidence still required

This file was reviewed against the public SQL definitions and Y's read-only report. Proposed SQL was parsed as syntax only, never executed. No private repo edits, migrations, wipes, database connections or deployments were performed. The revised kit needs independent review, fresh hashes and disposable restore/rehearsal evidence. The chase history FK issue remains an explicit blocker until that preservation design is settled.
