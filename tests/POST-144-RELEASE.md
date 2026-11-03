# Post-144 release packaging — AB

Review only. No SQL was applied here. This is part of candidate #247.

## Assumption and order

The safe reading of “after 144” is an explicit release phase after the frozen numbered baseline, not inserting N2 into that baseline's apply-twice replay. N2 deliberately renames the old AI functions. Putting it directly in the baseline would poison the unchanged 103/133/134 replay guards and their catalogue proofs. No frozen migration or assertion is weakened to get around this.

`supabase/release-plan.json` is the checked plan:

1. Apply/rehearse numbered migrations through 144 using the existing release chain. Baseline catalogue and apply-twice checks must pass first.
2. Post-144 step **145**: `supabase/release/145_company_setup.release.sql`, then `supabase/verify/company_setup_145.sql` and the setup isolation tests.
3. Post-144 step **146**: `supabase/release/146_tolra_provided_ai.release.sql`, then `supabase/verify/tolra_provided_ai_146.sql` and both AI/cap proofs, including the two-connection race.
4. Read `supabase/verify/release_preflight.sql` again: both `post-144 marker` rows must say applied before go-live. Ordinary baseline AI body checks use the preserved own-key aliases after 146; the 146 marker separately pins all ten live function bodies, definer/search-path metadata and sensitive grants.

145/146 are reserved in this candidate's release plan and filenames; they are **not** normal `supabase/migrations/` files. The plan checker detects a later numbered migration taking either number and refuses. A later schema release must reconcile the plan instead of silently reusing these numbers. Fresh Supabase baseline reset does not install these phases; the explicit CI release steps do. Startup installs neither.

These two post-144 steps remain intentionally one-time: a second attempt refuses on existing tables or N2's original-body guard and rolls back. It never resets setup ticks, caps, keys or usage. Code must rehearse first application, explicit refusal/no-change on repeat and rollback on its disposable database before approval. Do not run the old proposal separately after installing its release copy.

## Packaged files and unchanged behavior

The packaged forward files contain the exact canonical proposal body inside one transaction, preceded by the prerequisite guard. Matching rollback and verify files are included. N5 depends on 144's helper; N2 depends on 144 plus the N5 table. The original proposal files stay as source for existing tests and reviewers. No RLS policy, application behavior or AI cap calculation is changed by packaging.

The plan also accounts for every other SQL file under proposals: chase atomic settings still needs its separate release decision after 138; costing atomic settings is deferred because 143 is absent; the shared atomic rollback is rollback only. Listing these is not approval to apply them. Read-only preflight reports each disposition. The new unit tests fail when any existing/new proposal is absent from the preflight or plan, when either phase marker is removed, when numbers collide, or when canonical SQL changes without updating its release copy.

CI retains all three proposal-dependent test files, now running the packaged release copies after the baseline rehearsal. The loopback guard, verification failure handling and test assertions remain intact. No new SQL execution was initiated in this session.

## Rollback and evidence

Review rollback in reverse order, 146 then 145, separately from the normal baseline. 146 first refuses outstanding Tolra reservations, restores own-key functions, keeps request history/key_source and usage, and turns off features for companies that selected the removed Tolra mode. 145 removes setup ticks only. Rollback is a destructive decision requiring its own review, not an automatic cleanup step.

The strict baseline catalogue snapshot is deliberately unchanged: it still covers numbered migrations through 144. Post-144 structural/security checks and all existing role/isolation/race proofs remain separate and mandatory. Code's actual database and browser evidence is still required; unit checks and a successful application build do not prove SQL execution.
