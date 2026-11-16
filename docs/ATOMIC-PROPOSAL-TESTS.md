# Atomic settings SQL tests

Not executed by builder 2. No proposal or test SQL has been applied anywhere for this job.

After review, run: node scripts/test-atomic-proposals.mjs

Docker and npm dependencies must be installed. The runner creates a new PostgreSQL 17 container with a random database and password, binds only to loopback, ignores existing database URLs and deletes the container afterwards. No hosted database option exists. The test refuses a populated database before writing. A two-minute process timeout prevents a failed concurrency test keeping the runner alive.

It loads both real proposal files, then checks two companies, office/admin writes, ordinary workshop/viewer refusal, support/read-only/MFA refusal, wrong-company calls, foreign material/machine IDs and stale foreign step IDs, fractional pennies, duplicate IDs, real simultaneous saves and late-error rollback. The second writer must actually wait on the advisory lock; another company must remain writable. The rollback file is checked twice, preserves all settings, removes the RPCs, and the proposals can then be loaded again.

The standalone SQL fixture supplies test authentication helpers and a small table/RLS contract. It does not load the full production schema, session/MFA code, audit triggers, step-count guard or Auth service. This is portable Postgres transaction/contract coverage, not proof of real Supabase permissions. Claude still needs to run the existing 138/143 database suites and these cases against the integrated disposable Supabase schema before production. No tests have been weakened and no database pass is claimed here.

Static checks performed here: JavaScript syntax, fixture/proposal/rollback paths and diff whitespace. The actual PostgreSQL cases remain unrun under Rhys’s instruction not to apply anything anywhere.
