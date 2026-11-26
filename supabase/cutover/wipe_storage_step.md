# Storage step (run ONLY after the wipe SQL succeeded, and only with the owner's yes)

SQL cannot delete Storage files (a protect trigger on storage.objects), so this uses the Storage API with the project's service-role key. The key is never pasted in chat or committed: export it in the shell only.

## Exact list (captured from production, read-only, 26 Nov; confirm with `wipe_storage_list.sql` before the wipe)
| bucket | object name | size | source row |
|---|---|---|---|
| job-drawings | 264fe031-5381-4d70-a8fd-113c1713bc65/bed73b7d-7cd5-427f-892c-d5358b155e42/1795348824634-TEST-do-not-use.png | 37,667 | job_files |
| job-drawings | 264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/1791976791425-image.jpg | 3,085,526 | job_files |
| job-photos | 264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/photos/6fcf3be0-912f-414b-9f23-b2bd1a9ceb0a.jpg | 881,577 | job_files |
| job-photos | 264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/photos/b7ec6eaf-bffd-41b7-8f00-119595d90bfa.jpg | 1,078,718 | job_files |

document_attachments and quote_attachments have 0 rows for either company, so nothing else is tied to wiped rows. NOT deleted: org-logos/264fe031.../logo-1791492821252.png (JNR's company logo, kept) and org-logos/75b27c0c.../logo-1794308781434.png (the deleted live company's logo: it becomes an orphan file; add it to the list only if the owner says so).

## Rules (reviewer point 11)
- The list above is generated from the wiped rows (`wipe_storage_list.sql`, run BEFORE the wipe; it returned exactly these 4). The run deletes ONLY these 4 exact object paths. There is no bucket delete and no folder or prefix delete: the API field is called `prefixes` but each entry here is a full object path.
- Before deleting, compare the query result with this table; after, verify with the SQL below. Anything else in a bucket is left alone.

## Commands (service-role key in the shell only)
```bash
export SUPABASE_URL="https://qngvemzbdsvtydkbplpo.supabase.co"
export SERVICE_ROLE_KEY="<service role key, from the Supabase dashboard, not committed>"
curl -sS -X DELETE "$SUPABASE_URL/storage/v1/object/job-drawings" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d '{"prefixes":["264fe031-5381-4d70-a8fd-113c1713bc65/bed73b7d-7cd5-427f-892c-d5358b155e42/1795348824634-TEST-do-not-use.png","264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/1791976791425-image.jpg"]}'
curl -sS -X DELETE "$SUPABASE_URL/storage/v1/object/job-photos" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d '{"prefixes":["264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/photos/6fcf3be0-912f-414b-9f23-b2bd1a9ceb0a.jpg","264fe031-5381-4d70-a8fd-113c1713bc65/dc815b84-f888-4af0-80fd-f816551847b6/photos/b7ec6eaf-bffd-41b7-8f00-119595d90bfa.jpg"]}'
```
## Verify (read-only SQL)
`select bucket_id, count(*) from storage.objects group by 1;` must show job-drawings 0 and job-photos 0 (org-logos 2 unless the live company logo is also removed). Each curl returns the list of removed objects.
