-- READ ONLY: collect counts, company ownership, stable record IDs and full-row hashes, not request content or keys.
-- Run only against the target authorised for that run. This job uses only its own synthetic disposable database.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset format unaligned
\pset tuples_only on
BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
-- Does not bypass RLS: makes a filtered read ERROR rather than silently returning an incomplete manifest.
SET LOCAL row_security = off;
WITH records AS MATERIALIZED (
 SELECT id::text, organization_id::text,
        encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS row_sha256
 FROM public.ai_helper_requests r
), counts AS (
 SELECT organization_id,count(*) AS n FROM records GROUP BY organization_id
)
SELECT jsonb_build_object(
 'format_version',1,'table','public.ai_helper_requests',
 'captured_at_utc',now(),'database',current_database(),'database_user',current_user,
 'read_only',current_setting('transaction_read_only')='on',
 'total',(SELECT count(*) FROM records),
 'counts',coalesce((SELECT jsonb_object_agg(organization_id,n) FROM counts),'{}'::jsonb),
 'rows',coalesce((SELECT jsonb_agg(to_jsonb(records) ORDER BY id) FROM records),'[]'::jsonb)
)::text;
ROLLBACK;
