-- export_legacy.sql: READ-ONLY. Run on the OLD single-tenant project in the Supabase SQL editor.
--
-- One SELECT, one JSON document with every row of the tables that move to the new project:
--   organizations, user_profiles, customers, suppliers, stock, rfqs, quotes, invoices, jobs, sales_orders,
--   purchase_orders, delivery_notes, email_history and security_audit.audit_log.
-- Nothing is written. Copy the single cell of the result (the "export" column, or "Copy cell" / "Download")
-- and paste it into import_legacy_tenant.sql's call on the NEW project (see supabase/README.md, path B).
--
-- Passwords are not exported (they live in auth.users, which is not touched); users are re-invited on the new
-- project and matched to their profile by e-mail address.

SELECT jsonb_build_object(
  'format',      'quoteflow-legacy-export/1',
  'exported_at', now(),
  'counts', jsonb_build_object(
    'organizations',   (SELECT count(*) FROM public.organizations),
    'user_profiles',   (SELECT count(*) FROM public.user_profiles),
    'customers',       (SELECT count(*) FROM public.customers),
    'suppliers',       (SELECT count(*) FROM public.suppliers),
    'stock',           (SELECT count(*) FROM public.stock),
    'rfqs',            (SELECT count(*) FROM public.rfqs),
    'quotes',          (SELECT count(*) FROM public.quotes),
    'invoices',        (SELECT count(*) FROM public.invoices),
    'jobs',            (SELECT count(*) FROM public.jobs),
    'sales_orders',    (SELECT count(*) FROM public.sales_orders),
    'purchase_orders', (SELECT count(*) FROM public.purchase_orders),
    'delivery_notes',  (SELECT count(*) FROM public.delivery_notes),
    'email_history',   (SELECT count(*) FROM public.email_history),
    'audit_log',       (SELECT count(*) FROM security_audit.audit_log)
  ),
  'organizations',   COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id) FROM public.organizations t),   '[]'::jsonb),
  'user_profiles',   COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id) FROM public.user_profiles t),   '[]'::jsonb),
  'customers',       COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.customers t),       '[]'::jsonb),
  'suppliers',       COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.suppliers t),       '[]'::jsonb),
  'stock',           COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.stock t),           '[]'::jsonb),
  'rfqs',            COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.rfqs t),            '[]'::jsonb),
  'quotes',          COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.quotes t),          '[]'::jsonb),
  'invoices',        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.invoices t),        '[]'::jsonb),
  'jobs',            COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.jobs t),            '[]'::jsonb),
  'sales_orders',    COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.sales_orders t),    '[]'::jsonb),
  'purchase_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_orders t), '[]'::jsonb),
  'delivery_notes',  COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.delivery_notes t),  '[]'::jsonb),
  'email_history',   COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.drafted_at, t.id) FROM public.email_history t), '[]'::jsonb),
  'audit_log',       COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id) FROM security_audit.audit_log t), '[]'::jsonb)
) AS export;
