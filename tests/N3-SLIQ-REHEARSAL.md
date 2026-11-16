# N3 synthetic preprocessor database rehearsal

Builder 5, claim `claims/N3`, draft PR #368. Synthetic only; no production SQL, real data or contact with John.

Coordinator decision: no private source in a public run. `scripts/n3/preprocess.mjs` is a freshly written **rehearsal copy**, restricted to the small synthetic invoice/payment report shapes in this suite. It is not the private tool and cannot validate or approve that tool. It holds all credits, supports only the fixture payment methods and has no production CLI. No private checkout, private-source token or external module override remains.

The workflow overlays the public rehearsal onto public candidate `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. The runner still refuses any other base commit. The path tested is `planSheet` → `buildImport` → authenticated `import_company_data` (via `commitSingle`, or `p_dry_run=true` for N3-09). No app/importer changes.

Nine checks: invalid dates; stripped title/group/totals; Quotes refused as invoices; duplicate/conflicting numbers; orphan credits held; fresh-key replay; individual payment links/dates/methods/counts/pence/balances; one-bad-row atomicity; **N3-09 dry run with snapshot equality**. Snapshots cover both synthetic tenants' business records, counters and import keys; they exclude audit/import bookkeeping, which the existing importer may record even for dry runs. No claim of zero metadata writes.

The stack remains fresh, local and disposable with inherited DB settings/existing stacks refused and synthetic-tenant verification before writes. The custom reporter emits only counts and fixed check IDs/statuses to `results.json`; the gate requires nine passes, zero skips/todos/errors. Only that file is uploaded. Logs, source, environment files, test names, failure messages and stack traces are not artifacts.

## Temporary trigger — remove later

`push` is temporarily enabled **only** for `codex/b5-n3-sliq-rehearsal` to register the workflow. Remove this trigger after the coordinator confirms registration. Publishing this requested update may cause GitHub to start a push run automatically. No workflow dispatch or local execution is requested or performed in this revision.

Exact later manual command:

```sh
gh workflow run n3-sliq-rehearsal.yml --repo rhyshume1997-alt/tolra-public --ref codex/b5-n3-sliq-rehearsal
```

No private-source secret is needed. None was created by builder 5. The ordinary job token is used only for public checkout/image pulls.

## Handover

This revision was inspected and whitespace-checked only; it was **not run or dispatched**. Earlier results were for the superseded private-source version, not this rehearsal copy. Database proof remains **UNPROVEN** pending an authorised run of all nine checks. This is not C07’s pg-safeupdate-library proof, a large staged-import proof or approval to import raw reports.
