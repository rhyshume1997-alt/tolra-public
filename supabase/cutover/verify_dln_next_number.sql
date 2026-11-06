-- READ ONLY. Cutover day, after set_dln_next_number.sql: the independent verifier runs this with the company slug and John's number
-- AS THEY READ IT BACK THEMSELVES, and checks every result is PASS (10 rows). For a deliberate start at DLN-0001 the number is 0.
--   psql "$DATABASE_URL" -X -v company_slug=<slug> -v last_pad_number=<number> -f supabase/cutover/verify_dln_next_number.sql
WITH input AS (SELECT :'company_slug'::text AS slug, :'last_pad_number'::text AS raw),
org AS (SELECT o.id, o.name FROM public.organizations o, input WHERE o.slug = input.slug),
c AS (SELECT d.last FROM public.doc_counters d, org WHERE d.organization_id = org.id AND d.prefix = 'DLN'),
notes AS (SELECT max(substring(n.dn_number FROM '^DLN-(\d{1,12})$')::bigint) AS high, count(*) AS dln_notes,
                 count(*) - count(DISTINCT n.dn_number) AS duplicates
          FROM public.delivery_notes n, org WHERE n.organization_id = org.id AND n.dn_number ~ '^DLN-\d{1,12}$'),
marks AS (SELECT count(*) FILTER (WHERE a.action = 'DLN_COUNTER_SET') AS sets, count(*) FILTER (WHERE a.action = 'DLN_COUNTER_UNDONE') AS undos,
                 max(a.created_at) FILTER (WHERE a.action = 'DLN_COUNTER_SET') AS set_at,
                 (array_agg((a.new_data ->> 'last') ORDER BY a.created_at DESC) FILTER (WHERE a.action = 'DLN_COUNTER_SET'))[1] AS set_last
          FROM security_audit.audit_log a, org WHERE a.organization_id = org.id AND a.entity_table = 'doc_counters' AND a.entity_id = org.id::text),
v AS (SELECT (SELECT name FROM org) AS company, (SELECT last FROM c) AS last, notes.*, marks.*,
             CASE WHEN (SELECT raw FROM input) ~ '^(0|[1-9][0-9]{0,8})$' THEN (SELECT raw FROM input)::int END AS want FROM notes, marks),
r(n, "check", value, ok) AS (
  SELECT 1, 'company', coalesce(company, '(not found)'), company IS NOT NULL FROM v
  UNION ALL SELECT 2, 'stored counter (last DLN number taken or set)', coalesce(last::text, '(none)'), last IS NOT NULL FROM v
  UNION ALL SELECT 3, 'next DLN number', CASE WHEN last IS NULL THEN '(none)' WHEN last + 1 < 10000 THEN 'DLN-' || lpad((last + 1)::text, 4, '0') ELSE 'DLN-' || (last + 1) END, last IS NOT NULL FROM v
  UNION ALL SELECT 4, 'highest existing DLN note', coalesce('DLN-' || CASE WHEN high < 10000 THEN lpad(high::text, 4, '0') ELSE high::text END, '(none)') || ' of ' || dln_notes || ' DLN notes', coalesce(high, 0) <= coalesce(last, -1) FROM v
  UNION ALL SELECT 5, 'step recorded once (DLN_COUNTER_SET minus undone)', (sets - undos)::text || ' at ' || coalesce(set_at::text, '-'), sets - undos = 1 FROM v
  UNION ALL SELECT 6, 'set to the number read back from John', coalesce(set_last, '-') || ' vs ' || coalesce(want::text, 'invalid input'), set_last::int IS NOT DISTINCT FROM want AND want IS NOT NULL FROM v
  UNION ALL SELECT 7, 'counter not behind the number set (moves on only as notes are made)', coalesce(last::text, '-'), last >= set_last::int FROM v
  UNION ALL SELECT 8, 'no duplicate DLN numbers in the company', duplicates::text, duplicates = 0 FROM v
  UNION ALL SELECT 9, 'unique index on (organization_id, dn_number)', 'delivery_notes_dn_number_org_uniq',
                   EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'delivery_notes_dn_number_org_uniq')
  UNION ALL SELECT 10, 'delivery notes unlocked for the company (no release 147 hold left)',
                   CASE WHEN to_regclass('public.dln_numbering_pending') IS NULL THEN '147 not installed' ELSE 'held rows: ' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.dln_numbering_pending WHERE organization_id = %L', (SELECT id FROM org)), false, true, '')))[1]::text END,
                   to_regclass('public.dln_numbering_pending') IS NULL OR (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.dln_numbering_pending WHERE organization_id = %L', (SELECT id FROM org)), false, true, '')))[1]::text = '0'
)
SELECT "check", value, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result FROM r ORDER BY n;
