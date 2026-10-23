-- READ ONLY. Sales orders that have more than one job converted from them (audit D3). Expected: no rows.
-- Nothing is deleted automatically: decide which job is the real one and resolve the others by hand.
SELECT j.organization_id, so.so_number, j.converted_from_sales_order_id AS sales_order_id,
       array_agg(j.job_no ORDER BY j.created_at) AS jobs, so.converted_to_job_id AS linked_job_id
FROM public.jobs j
LEFT JOIN public.sales_orders so ON so.id = j.converted_from_sales_order_id
WHERE j.converted_from_sales_order_id IS NOT NULL
GROUP BY j.organization_id, so.so_number, j.converted_from_sales_order_id, so.converted_to_job_id
HAVING count(*) > 1
ORDER BY 1, 2;
