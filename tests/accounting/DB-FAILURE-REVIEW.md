# R: database failure review for accounting #221

Compared main `68f89ca` with #221 `7301937`. No database or SQL was run during this review.

The reported `time-labour.test.ts` release assertion and `workshop-network-128` proof, their helpers, migrations 051/078/092/128 and DB test configuration are unchanged by #221. This does not prove the accounting change is unrelated: there is an indirect schema replay effect.

Existing CI evidence: run 41662902454, integration check 126010581013, reports `tests/db/machine-runs-risk.test.ts:275`: “084: a function 084 creates already exists with another body; stop and compare it first”. This is the same #221 head. The test loops through 044 and every later migration using individually committed release wrappers. A failure at 084 rolls back 084 only, leaving the already committed 051/078 function bodies in the shared test database; 092/128 have not been restored yet. `vitest.db.config.ts` runs files serially, but the database is shared, so later files can observe that state.

144 originally replaced `integration_enqueue()` with the Xero-filtered version. 084 requires its original body hash `26bba3708dd4f02328376e1cd632f7d0`; the replaced body hashes to `2a9a71f8a116d3caf1232cb16609950f`. The new offline test evaluates that unchanged guard input from the actual migration files and failed on the old 144, then passed after this correction. It does not execute SQL or simulate the entire database.

Why this matches the two reported symptoms: 092's `labour_close` stores the admin release reason; 051's earlier version does not. 128 extends the cron's network purge to refusal addresses; the earlier purge does not cover them. Stopping the replay before 092/128 can therefore leave null release reasons and the wrong purge counts. Those two runtime failures were not independently reproduced here; their causal link still needs the clean database run below.

Correction: 144 leaves `integration_enqueue()` unchanged, creates `accounting_cloud_enqueue()` with exactly the previously reviewed Xero-only body, and rebinds the same invoice/credit-note triggers. Rollback restores their original targets before removing the new function. Verification checks the targets and unchanged 084 hash. No frozen migration, catalogue assertion or existing test was changed. After a complete replay 144 restores its own trigger targets. This fixes the directly reproduced guard collision without removing the read-only-provider send restriction.

Still required on an independently prepared disposable backend: fresh main versus corrected #221; each named test alone; then `machine-runs-risk`, `time-labour` and `workshop-network-128` together; then the full DB suite and upgrade checks. Record function hashes before/after the replay and actual counts. Catalogue differences from a new numbered migration need their own review; this file does not claim the full DB CI is repaired. No migration, backend setup or runtime DB test was executed for this review.
