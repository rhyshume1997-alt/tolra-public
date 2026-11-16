# G12 — Wipe control checklist and test plan

Draft 0.1 | Owner ____ | Reviewed final SHA ____ | Kit path/hash ____.

**NOT EXECUTED. This page does not permit a wipe.** This job uses synthetic records only. Production needs Rhys's separate written approval. The approved final wipe kit is not present in the public checkout; #373 and X4 #379 do not prove that kit safe.

## Before any rehearsal write

- [ ] Create the disposable target yourself. Retain its random creation ID/nonce, image digest, container ID, isolated network/ports and database identity. A name, marker or localhost address alone is not proof. Refuse any existing/unknown target.
- [ ] Identify the approved synthetic backup/fixture and restore it there. Record backup hash, restored schema/release SHA and the exact wipe SQL hash. Never attach production credentials, URLs or real data.
- [ ] List **every** table, file bucket/path, function, trigger and company. Mark each table KEEP or WIPE with its exact row filter, reason, owner and approval. Unknown/unlisted objects mean **STOP**. Default to KEEP. Never use an unscoped delete or truncate.
- [ ] Have a second person check the company UUID against its name and the script's scope. A database owner can bypass RLS: RLS is not a wipe safety net. Do not lift a numbering hold as part of wiping data.

## Required KEEP list

Retain all rows of every other company, including synthetic Marpet. Retain JNR control records in:

| Required KEEP object | Agreed rows/filter | Owner | Approval |
| --- | --- | --- | --- |
| `public.organizations` | ____ | ____ | ____ |
| `public.user_profiles`, `public.organization_members` | ____ | ____ | ____ |
| `public.organization_settings` | ____ | ____ | ____ |
| `public.doc_counters` | ____ | ____ | ____ |
| **`public.dln_numbering_pending`** (release 147) | ____ | ____ | ____ |
| `auth.*`, `security_audit.*` (including audit-chain history) | ____ | ____ | ____ |
| Integration/AI settings, credentials, ledgers; storage objects/files: enumerate exact names | ____ | ____ | ____ |

This minimum is **not** a complete approved schema inventory. Attach the full KEEP/WIPE register, including later releases. Missing expected tables, blank filters or unsigned decisions block execution. KEEP of numbering holds means their rows and timestamps stay identical, not merely that the table exists. The separate approved counter step has its own evidence.

## Test plan — one complete record per row

| Requirement ID | Expected result | Actual result | Evidence ref | Tester | Date | Approval |
| --- | --- | --- | --- | --- | --- | --- |
| G12-01 identity/plan refusal | Wrong identity/company/hash or missing KEEP item refuses before writes | ____ NOT EXECUTED | ____ | ____ | ____ | ____ |
| G12-02 dry run | Every table/file fingerprint is identical before/after | ____ NOT EXECUTED | ____ | ____ | ____ | ____ |
| G12-03 scoped rehearsal | Only approved synthetic JNR WIPE rows change; all KEEP and all Marpet rows/files/counters/holds stay identical | ____ NOT EXECUTED | ____ | ____ | ____ | ____ |
| G12-04 forced failure/repeat | Failure rolls back all changes; second run refuses or follows the approved documented rule | ____ NOT EXECUTED | ____ | ____ | ____ | ____ |
| G12-05 recovery | Restore returns every agreed object, trigger, constraint, audit-chain state and file to its baseline | ____ NOT EXECUTED | ____ | ____ | ____ | ____ |

Retain original failures, commit, environment, SQL hash, times, exit code and full before/after comparisons. Counts alone are insufficient. An unexplained change means STOP; preserve evidence and recover only the owned disposable target. No production wipe was run for this document.
