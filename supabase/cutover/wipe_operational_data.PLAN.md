# Data wipe plan (quoteflow-prod) — PREPARED, NOT RUN ON PRODUCTION

Script: `supabase/cutover/wipe_operational_data.sql` (one transaction; `dry_run` rolls back; refuses on any mismatch).
Status: rehearsed on scratch (tolra-scratch-07nov, synthetic ZZ companies shaped like production): dry run then real run, both clean.
Backup: full JSON export of both companies' rows, the live company, the 3 test users and the storage object list taken from production (read-only) before any run; kept outside the repo (it holds customer data).

## Production parameters (exact; `dry_run` stays true until the owner says go)
```json
{"confirm":"WIPE OPERATIONAL DATA","dry_run":true,"counters":"reset","allow_audit_row_delete":true,
 "wipe_orgs":["264fe031-5381-4d70-a8fd-113c1713bc65","2a213c03-c440-450d-9217-e2bbfcaff6b5"],
 "delete_org":"75b27c0c-2e85-486e-b1f4-4e9b9c045ca7",
 "delete_users":["6d084998-baad-49d3-b3aa-cad95a26560d","dc05fa61-1b18-4892-9abf-43ae651535d8","ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7"],
 "keep_admins":["cabd4289-e7dd-448e-9fed-a7cfab216cda","8703c781-adff-43f5-a258-dc1eb49c2d13"],
 "expected":{"264fe031-5381-4d70-a8fd-113c1713bc65":{"customers":9,"suppliers":9,"quotes":28,"jobs":27,"sales_orders":21,"purchase_orders":10,"delivery_notes":10,"invoices":20,"machines":1,"stock":6},
             "2a213c03-c440-450d-9217-e2bbfcaff6b5":{"customers":1,"quotes":3,"jobs":2,"sales_orders":1,"invoices":1}}}
```
Run as `SELECT pg_temp.tolra_wipe('<json>'::jsonb);` after the function definition, in the same session.

## Rehearsal evidence (scratch)
Seed: 3 synthetic companies (A like JNR, B like Marpet, L like the empty live one), 2 kept admins, 3 test users, rows in 24 wiped tables.
Dry run: rolled back as designed, result shown. Real run: wiped counts matched the seed; users deleted 3; company L deleted with its 2 audit rows listed; 193 guard triggers switched off then on; 0 triggers left disabled.
After: wiped tables 0 for A, B and L; organization_settings hidden_nav unchanged (ui-jobs-v2:on, ui-quotes-v2:on kept); email templates kept; both kept admins still active admins on A and B; test users gone; counters QUO/J/INV/SO/PO/CRD reset to 0, DLN left at 10; Marpet-like DLN hold row kept; one DATA_WIPE audit row per wiped company.
A bug found and fixed by the rehearsal: foreign-key cycle among quotes, RFQs, sales orders, jobs, customers (the script now sets the nullable links in the cycle to NULL first, only for the wiped companies' rows).

## Owner decisions (Rhys, 26 Nov 10:36) — now built in
1. The live company's 2 audit rows (its own chain only) are deleted so the company is fully deleted: `allow_audit_row_delete: true`.
2. Counters for quote (QUO), job (J), invoice (INV), sales order (SO), purchase order (PO) and credit note (CRD) reset to 0 for JNR Engineering and Marpet: `counters: "reset"`. DLN counter and DLN hold are never touched by the script.
3. Storage: all files tied to wiped rows are removed by a separate API step after the SQL, with the owner's yes: `wipe_storage_step.md` (exact list of 4 files: 2 job drawings, 2 job photos; logos excluded) and `wipe_storage_list.sql` (read-only check to run before the wipe).
Still as before: Rhys's clock-in records (32 attendance events, 1 week approval) are kept; the audit log keeps copies of deleted rows' old data (append-only, untouched).
