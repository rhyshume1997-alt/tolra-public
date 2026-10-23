-- Step 06a: run on the OLD project JNREng. READ-ONLY. Row counts to compare with 06b.
SELECT 'customers' AS t, count(*) FROM public.customers
UNION ALL SELECT 'suppliers', count(*) FROM public.suppliers
UNION ALL SELECT 'stock', count(*) FROM public.stock
UNION ALL SELECT 'rfqs', count(*) FROM public.rfqs
UNION ALL SELECT 'quotes', count(*) FROM public.quotes
UNION ALL SELECT 'invoices', count(*) FROM public.invoices
UNION ALL SELECT 'jobs', count(*) FROM public.jobs
UNION ALL SELECT 'sales_orders', count(*) FROM public.sales_orders
UNION ALL SELECT 'purchase_orders', count(*) FROM public.purchase_orders
UNION ALL SELECT 'delivery_notes', count(*) FROM public.delivery_notes
UNION ALL SELECT 'email_history', count(*) FROM public.email_history
UNION ALL SELECT 'audit_log', count(*) FROM security_audit.audit_log
ORDER BY 1;
