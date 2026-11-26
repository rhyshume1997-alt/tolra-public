# Production schema (read-only) vs the schema the wipe was rehearsed on - 26 Nov, ~14:50 UK

Read-only: two SELECT statements on `pg_catalog` / `information_schema` / `pg_get_*` against quoteflow-prod (project `qngvemzbdsvtydkbplpo`) approved by Rhys 14:42. No row data, no writes, no wipe, no counts preflight, no production dry run. Compared with the local isolated Postgres built from the scratch definitions (head 949ad0d1).

## Production role the run would use (SQL editor / Supabase SQL)
`current_user = session_user = postgres`; NOT superuser; BYPASSRLS; CREATEROLE; member of pg_monitor, pg_signal_backend, pg_read_all_data, pg_create_subscription, anon, authenticated, service_role, authenticator, supabase_privileged_role. `role` setting `none` (so the script's browser-role refusal passes; it checks the effective role, not membership). Owns all 135 public + security_audit tables (124 public), so ALTER TABLE ... DISABLE TRIGGER on the allowlist and on `security_audit.audit_log` works. `auth.users` is owned by `supabase_auth_admin`; postgres holds INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on it. DELETE on `security_audit.audit_log` and on all 124 public tables: yes. Server 17.11 (local test was 16.15), TimeZone UTC, lock_timeout 0 (the script sets 10 s itself). No trigger is disabled anywhere on production today.
The earlier local runs used a superuser; they were repeated as a non-superuser role built like this (owner of all tables, BYPASSRLS, CREATEROLE, member of the API roles, auth.users owned by another role with the same privileges).

## Differences found (all of them)
| # | Item | Production | Tested on | Touches deletion / trigger / FK / preserved data? |
|---|------|-----------|-----------|--|
| 1 | `issues` table | 10 columns, NOT NULL on organization_id, page, body, status (default 'new'), urgent (default false), created_at, updated_at (default now()); FKs: organization_id -> organizations ON DELETE CASCADE, **user_id -> auth.users ON DELETE SET NULL** | table existed only through my inference: all nullable, no defaults, **no user_id FK** | **FK difference.** Deleting the 3 test users now SET NULLs any issues.user_id naming them (the one export row names Rhys, so nothing changes). `issues` is a KEPT table. Re-rehearsed. |
| 2 | `issue_owner_notes` | exists; PK issue_id; FK issue_id -> issues ON DELETE CASCADE; no organization_id | missing | Not a wipe table, not touched (issues is kept). Added; no effect. |
| 3 | `jobs.worksheet_custom` | jsonb NOT NULL DEFAULT '{}' | nullable, no default | Column on a wipe table; deletion unaffected. Corrected. |
| 4 | `job_values.id` | **uuid GENERATED ALWAYS AS (job_id) STORED** | plain uuid | Corrected; generated id equals the exported id for all 22 rows. |
| 5 | Trigger `jobs_worksheet_custom_lock` | BEFORE **UPDATE OF worksheet_custom** ON jobs, SECURITY DEFINER, exempts every role except anon/authenticated. Not a delete-time trigger. | missing | No: the wipe never updates jobs (the FK cycle is deleted in one statement) and runs as postgres. Added. |
| 6 | Trigger `invoice_lines_within_despatched` (allowlisted) | same trigger definition (AFTER INSERT OR DELETE OR UPDATE OF quantity, sales_order_line_id, invoice_id); **function body differs**: on DELETE it takes `order_lines_lock(...)` then returns | older body | The trigger is one of the 8 the script DISABLES for the run and re-enables and asserts, so its body never runs during the wipe. Re-rehearsed with the production body. This is the "331 of 332" delete-time difference: it was a body difference, not a missing trigger. |
| 7 | `platform_rollout_log` (+ `platform_roadmap_items`) | exist; BEFORE DELETE OR UPDATE guard and BEFORE TRUNCATE guard raise 'append-only'; no organization_id | missing | Not wipe or kept tables (no organization_id), never touched. Added; no effect. |
| 8 | Functions | 13 functions only on production (platform_* RPCs, raise_issue, `jobs_worksheet_custom_lock`, `_platform_owner_check`, `platform_rollout_log_guard`); `draft_invoice_order_lines` and `invoice_lines_within_despatched` bodies differ | older | RPCs, not fired by the wipe. |
| 9 | FKs to auth.users | 114 on production vs 103: 11 only on production = 10 auth-schema tables (identities, mfa_factors, mfa_recovery_code_sets, oauth_*, one_time_tokens, scim_users, sessions, webauthn_*) + `public.issues.user_id` (item 1) | stubs / missing | Auth-schema rows of the 3 deleted users cascade as with any Supabase user delete (expected; not counted by the script, which counts public + security_audit). |
| 10 | Identity columns (`job_flow_events.seq`, 3 security_audit tables) | identity | plain bigint | No. |
| 11 | CHECK constraints | 449 CHECKs exist on production and were not loaded locally (they never block a delete) | not loaded | No. |

Everything else compared equal by definition: all 521 primary, unique and foreign keys (including every public FK and its ON DELETE rule: the 204 of 205 "difference" was only the `issues` FK), all other 480 delete-time-relevant triggers by name, function and definition, trigger function bodies by md5 (except item 6), all other columns by name, type, NOT NULL, generated and identity flags.

## The script's own guards, evaluated on the production definitions
- Classification: every production public table with `organization_id` is in the wipe, kept or special list: **none unclassified**.
- FK guard: no CASCADE / SET NULL / SET DEFAULT FK from outside the wipe list into a wipe table other than the reviewed `invoice_reminder_sends`.
- Delete-time triggers on the 60 wipe tables: every one is in the allowlist, the leave-on list or the three kept guard functions; **none unreviewed**; all 21 reviewed ones exist on production, enabled ('O').

## Re-rehearsal on the corrected schema, as a non-superuser role (this folder: test_dry2.out, test_real2.out, test_neg2.out)
- Dry run: DRY_RUN_ROLLED_BACK; fingerprints of all 136 tables equal; 0 DATA_WIPE rows.
- Real run in a transaction: all 60 wipe tables 0 for both companies; 2 organizations; 3 test users gone; counters QUO, J, INV, SO, PO, CRD 0, DLN untouched; no trigger left disabled; then ROLLBACK: 136 of 136 fingerprints identical, 0 DATA_WIPE rows.
- Negative tests: 9 of 9 refused.
- Lock test as that role: wipe blocked by a writer aborts at 10.0 s with 55P03; a writer blocked by the wipe aborts at its 2 s timeout with 55P03.
- One setup error found and fixed on the way (local only): the first non-superuser run failed with "permission denied for schema auth" because my stub `auth` schema was not owned by the role that owns `auth.users`; in production that schema is owned by `supabase_auth_admin`. Not a wipe defect.

## Still not tested / limits
Production is Postgres 17.11, local is 16.15. The 449 CHECK constraints and auth-schema internals were not replicated. The real concurrent traffic and the maintenance-window preflight (production counts, Storage list, nothing writing to JNR or Marpet) are still to do and wait for Rhys's window and final yes.
