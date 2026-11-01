-- Migration 126 (a booking with recorded machine time is not removed; a quote for 0.00 is not accepted). Read only: every row should be
-- TRUE (4). Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proacl, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.delete_machine_booking(uuid)'), to_regprocedure('public.accept_quote(uuid, text, date, uuid[])'))
)
-- delete_machine_booking: 126's body (refuses a booking any run points at, after locking it).
SELECT 'delete_booking_is_126' AS check_name,
  coalesce((SELECT body = '1fee96ce68caa2bcbf89f416587e75ba' FROM fn WHERE proname = 'delete_machine_booking'), FALSE) AS ok
-- accept_quote: 126's body (refuses a quote for 0.00 in whole pence).
UNION ALL SELECT 'accept_quote_is_126',
  coalesce((SELECT body = '4f354d3878197aabe53db19807f99305' FROM fn WHERE proname = 'accept_quote'), FALSE)
-- Exactly one of each (accept_quote only in 068's four-argument form).
UNION ALL SELECT 'one_signature_each',
  (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'delete_machine_booking')
  AND (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'accept_quote')
-- Both: definer, volatile, the pinned search_path, signed-in only (authenticated may; anon and PUBLIC may not).
UNION ALL SELECT 'definer_pinned_signed_in_only',
  (SELECT count(*) = 2 AND bool_and(prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM fn);
