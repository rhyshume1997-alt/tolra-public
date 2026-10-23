-- READ ONLY. Lists business links that point at a record of a different organisation (audit SEC14).
-- Run before and after migration 015. Expected on a healthy database: no rows.
-- Nothing is changed or deleted: any row found is for a person to look at and repair deliberately.
SELECT 'quotes.rfq_id' AS link, c.id AS child_id, c.organization_id AS child_org, p.id AS parent_id, p.organization_id AS parent_org
  FROM public.quotes c JOIN public.rfqs p ON p.id = c.rfq_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'sales_orders.quote_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.sales_orders c JOIN public.quotes p ON p.id = c.quote_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'sales_orders.customer_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.sales_orders c JOIN public.customers p ON p.id = c.customer_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'sales_orders.converted_to_job_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.sales_orders c JOIN public.jobs p ON p.id = c.converted_to_job_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'jobs.quote_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.jobs c JOIN public.quotes p ON p.id = c.quote_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'jobs.converted_from_sales_order_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.jobs c JOIN public.sales_orders p ON p.id = c.converted_from_sales_order_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'invoices.job_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.invoices c JOIN public.jobs p ON p.id = c.job_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'delivery_notes.sales_order_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.delivery_notes c JOIN public.sales_orders p ON p.id = c.sales_order_id WHERE p.organization_id <> c.organization_id
UNION ALL
SELECT 'delivery_notes.customer_id', c.id, c.organization_id, p.id, p.organization_id
  FROM public.delivery_notes c JOIN public.customers p ON p.id = c.customer_id WHERE p.organization_id <> c.organization_id
ORDER BY 1, 2;
