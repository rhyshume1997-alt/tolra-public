-- Migration 134 PRECHECK: run on production BEFORE pasting 134's release SQL. Read only (one SELECT; writes nothing).
-- TRUE only when the live public.convert_sales_order is exactly the body 134 replaces: 080's, md5 dc8165549871bd15047765ac4fba811e,
-- compared the way 134's guard (section 1) and the release preflight compare bodies: md5 of prosrc with every whitespace character
-- removed (an SQL-editor paste may store CRLF). Also one function of that name only. FALSE (or the md5 shown is not 080's): stop, do not
-- paste 134, and send the live_md5 back for comparison. Already 5c32fec88493cce71da2cd55f83ff7b4: 134 is already applied (also FALSE here).
SELECT
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'dc8165549871bd15047765ac4fba811e'
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)')), FALSE)
  AND (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'convert_sales_order') AS ok_to_apply_134,
  (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)')) AS live_md5;
