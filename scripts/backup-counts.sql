-- READ ONLY. Rows per table (public, security_audit, auth.users), written into every backup and compared after a
-- restore (scripts/backup-run.sh, scripts/restore-backup.sh). One "schema.table<TAB>rows" line per table.
SELECT t.table_schema || '.' || t.table_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::TEXT
FROM information_schema.tables t
WHERE t.table_type = 'BASE TABLE'
  AND (t.table_schema IN ('public', 'security_audit') OR (t.table_schema = 'auth' AND t.table_name = 'users'))
ORDER BY 1;
