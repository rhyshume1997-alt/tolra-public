-- 134 production OFF check (G3, the AI assistant). ONE read-only SELECT: it writes nothing and changes no setting. Rhys runs it on
-- production (SQL editor) after the release, and again before any go-live step. `ok` is TRUE only when no company has the assistant,
-- the round-up or the RFQ helper switched on. It also answers TRUE when the AI helper's settings table is not there at all (101 not
-- applied: nothing can be on) and works before 134 (no assistant_enabled column yet: read as off). The other columns say which
-- switches are on, and for how many companies (all 0 when ok).
-- The server switches are Vercel environment variables, not in the database: AI_HELPER_ENABLED and AI_ASSISTANT_ENABLED must be unset
-- (or anything but exactly "true") in every Vercel environment.
SELECT n.assistant_on + n.roundup_on + n.rfq_on = 0 AS ok,
       n.settings_table, n.companies_with_settings, n.assistant_on, n.roundup_on, n.rfq_on
FROM (
  SELECT to_regclass('public.ai_helper_settings') IS NOT NULL AS settings_table,
         coalesce(c[1], 0) AS companies_with_settings, coalesce(c[2], 0) AS assistant_on, coalesce(c[3], 0) AS roundup_on, coalesce(c[4], 0) AS rfq_on
  FROM (
    SELECT CASE WHEN to_regclass('public.ai_helper_settings') IS NOT NULL THEN
             (SELECT array_agg(v::TEXT::INTEGER ORDER BY o) FROM unnest(xpath('/row/*/text()', query_to_xml(
                'SELECT count(*) AS a,
                        count(*) FILTER (WHERE coalesce((to_jsonb(s) ->> ''assistant_enabled'')::BOOLEAN, FALSE)) AS b,
                        count(*) FILTER (WHERE s.roundup_enabled) AS c,
                        count(*) FILTER (WHERE s.rfq_enabled) AS d
                 FROM public.ai_helper_settings s', FALSE, TRUE, '')::XML)) WITH ORDINALITY AS x(v, o))
           END AS c
  ) q
) n;
