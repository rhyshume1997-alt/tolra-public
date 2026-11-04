# N3 SliQ preprocessor database rehearsal

Synthetic only. One draft PR; no production SQL, real files, workflow dispatch or message to John. Claim `claims/N3`; builder 5. No application/importer change.

Private source was readable. The manual workflow checks out only the preprocessor and strict report parser from private `quoteflow-jnr` commit `36b1208a83a1d10a9b4bb6562b4e79eb61234007`; no private code is copied into this public PR. It tests against public candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8` in a separate checkout. The private fix plan says the provisional CLI is not suitable for these report files, so this rehearsal uses `planSheet` → `buildImport` → `commitSingle` → authenticated `import_company_data`, not a replacement importer.

Eight named checks: invalid dates; stripped title/group/totals; Quotes refused as invoices; repeated/conflicting invoice numbers; orphan credits held; new-operation-key re-import without duplicates; every payment’s invoice/date/method/pence plus counts/totals/balances and payment replay; one bad database row leaves business records unchanged. Invalid preprocessor cases also compare database state. Both synthetic tenants and counters/import keys are snapshotted; import/audit bookkeeping is not treated as business data. Only allowed clean output filenames can enter a payload. No skip or missing/empty report can pass the eight-test gate.

## Run later — not dispatched here

Configure repository secret `N3_PRIVATE_SOURCE_TOKEN` with **read-only contents access to quoteflow-jnr**. The default GITHUB_TOKEN cannot read that other private repo. No database secrets are accepted: the runner creates a fresh local Supabase stack, refuses existing stacks/config/DB overrides, verifies loopback/local keys and synthetic tenants, and removes the stack on exit. Artifacts contain only synthetic run results, not private source or `.env.test.local`. This is not C07’s pg-safeupdate-library proof.

```sh
gh workflow run n3-sliq-rehearsal.yml --repo rhyshume1997-alt/tolra-public --ref codex/b5-n3-sliq-rehearsal
```

GitHub must first register this manual workflow on the default branch through the normal review/merge process; the command then selects the draft branch’s workflow version. This PR does not merge it or dispatch it. A missing token, unavailable private source, startup problem or failed test must fail the run, never trigger a fallback database.

Local validation and remaining limits are recorded below before handover. Actual database results remain **UNPROVEN** until a disposable run passes. This is a rehearsal of the pre-step plus app import path; raw report imports and untested large staged imports are not approved by it.

## Builder handover / local checks

- TypeScript, targeted ESLint, shell/Node syntax and YAML/manual-only trigger checks passed. The three app modules and fixture support match the pinned candidate’s blobs.
- Synthetic preflight checked N3 report shapes, furniture counts, date/duplicate/type refusals and payment input reconciliation; no database used.
- Database attempt: suite failed at `TEST_SUPABASE_URL is not set`; all eight tests reported skipped by the failed setup, **zero database passes**. Docker socket access was denied. The gate rejected that report as required. Do not call collection a rehearsal pass.
- An additional upstream preprocessor test attempt in the downloaded source copy had 14 passes and one failure in its CLI output-folder refusal check. That CLI path is not used by this rehearsal; it still needs checking in a proper private checkout. No private source was modified or published.
- Next: review this draft and token/workflow setup, then the authorised operator may dispatch the exact command above and assess all eight results. Nothing has been dispatched, merged or run on production; John was not contacted.
