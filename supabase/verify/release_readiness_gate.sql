-- READ ONLY. Production release readiness gate (companion of scripts/release-readiness-gate.mjs). SELECT only: nothing is written,
-- no setting is changed. Each section below is ONE statement, run by the script in its own savepoint inside a READ ONLY transaction, so
-- a section that cannot be read (a missing table, no permission) is reported as unreadable (NO GO) and never hides the others.
-- Counts and names only: no factor secret, key, token or amount is selected. The script splits this file on the "@section" lines.

-- @section dln params: slug
-- 2. JNR delivery-note counter decision (set_dln_next_number.sql writes DLN_COUNTER_SET, keep_dln_numbering.sql writes DLN_HOLD_RELEASED).
WITH o AS (SELECT id FROM public.organizations WHERE slug = $1)
SELECT (SELECT count(*) FROM o)::int AS org_found,
  (SELECT count(*) FROM security_audit.audit_log a JOIN o ON a.entity_id = o.id::text WHERE a.action = 'DLN_COUNTER_SET')::int AS counter_set,
  (SELECT count(*) FROM security_audit.audit_log a JOIN o ON a.entity_id = o.id::text WHERE a.action = 'DLN_HOLD_RELEASED')::int AS hold_released,
  (SELECT count(*) FROM security_audit.audit_log a JOIN o ON a.entity_id = o.id::text WHERE a.action = 'DLN_COUNTER_UNDONE')::int AS counter_undone,
  (SELECT count(*) FROM public.dln_numbering_pending p JOIN o ON p.organization_id = o.id)::int AS jnr_pending,
  (SELECT count(*) FROM public.dln_numbering_pending p WHERE p.organization_id NOT IN (SELECT id FROM o))::int AS other_held_count,
  (SELECT coalesce(string_agg(g.slug, ', ' ORDER BY g.slug), '') FROM public.dln_numbering_pending p JOIN public.organizations g ON g.id = p.organization_id WHERE g.id NOT IN (SELECT id FROM o)) AS other_held;

-- @section mfa
-- 3. MFA readiness: counts per company of active admins with and without a verified TOTP factor, and the company flag. Counts only.
SELECT o.slug::text AS company, o.require_admin_mfa AS flag_on,
  count(m.user_id)::int AS admins,
  count(m.user_id) FILTER (WHERE EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = m.user_id AND f.factor_type = 'totp' AND f.status = 'verified'))::int AS with_factor
FROM public.organizations o
LEFT JOIN public.organization_members m ON m.organization_id = o.id AND m.active AND NOT m.support AND (m.role = 'admin' OR m.secondary_role = 'admin')
GROUP BY o.id, o.slug, o.require_admin_mfa
ORDER BY o.slug;

-- @section xero_hold
-- 5a. Xero launch hold (149): one row per company; every enabled must be false.
SELECT (SELECT count(*) FROM public.organizations)::int AS companies,
  count(*)::int AS hold_rows,
  count(*) FILTER (WHERE h.enabled)::int AS held,
  coalesce(string_agg(o.slug, ', ' ORDER BY o.slug) FILTER (WHERE h.enabled), '') AS held_companies
FROM public.xero_transfer_hold h JOIN public.organizations o ON o.id = h.organization_id;

-- @section xero_sends
-- 5b. Xero sends stuck mid-way.
SELECT count(*) FILTER (WHERE status = 'needs_check')::int AS needs_check,
  count(*) FILTER (WHERE status = 'sending')::int AS sending
FROM public.integration_sends;

-- @section ai_control
-- 6a. Tolra-provided AI master switch (146): the singleton row must exist and be off.
SELECT count(*)::int AS rows, count(*) FILTER (WHERE enabled)::int AS enabled_rows FROM public.ai_helper_tolra_control;

-- @section ai_flagged
-- 6b. Companies whose AI cap 150 flagged for review (report only).
SELECT coalesce(o.slug::text, '(unknown company)') AS company, a.created_at::text AS flagged_at
FROM security_audit.audit_log a LEFT JOIN public.organizations o ON o.id::text = a.entity_id
WHERE a.action = 'ai_cap_review_flagged'
ORDER BY a.created_at, 1;

-- @section invoice_statuses
-- 7. Every distinct invoice status in use.
SELECT DISTINCT coalesce(status::text, '(null)') AS status FROM public.invoices ORDER BY 1;
