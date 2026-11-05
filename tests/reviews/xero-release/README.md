# Xero OFF and release verification, builder 3

Subject: PR #415, pinned `e42d927383513d1b98ce9cfca444884475622e2f`. Review branch only; no candidate edits, merge, production SQL or live Xero calls.

## Work saved so far

- Candidate Xero unit tests: 200 passed, 0 failed, 0 skipped (mock transport)
- Candidate migration 149 database tests: 20 passed, 0 failed, 0 skipped
- Disposable PostgreSQL 17.6: baseline through 137, then 138, 140, 141, 143, 144, 145, 146, 147, 149, 150 applied; all ten companion verifications passed
- Reverse rollback completed: 150, 149, 147, 146, 145, 144, 143, 141, 140, 138
- Populated 149 rollback correctly refused a connected company held OFF; the explicit old-sending acceptance was tested only in the disposable database to continue the rehearsal
- Reapplying 146 after rollback correctly refused because its retained key_source column exists
- #396 regression tests against #415: 2 passed, 14 failed, 0 skipped. This is a real missing read-back safeguard, not a green release recommendation

Commands and detailed path comparison will follow here. Raw receipts are under `evidence/`. This is work in progress, not release sign-off.

## Handover

Done: pinned snapshot, initial tests, release chain and guarded rollback, #396 reproduction. In progress: remaining path coverage and #403/#408 comparison. Not started: final plain-English PR summary. No human signatory or approval is supplied by this review.
