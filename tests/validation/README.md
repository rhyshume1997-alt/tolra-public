# Tolra validation pack

**Software status: NOT VALIDATED.** #258 is SAFE WITH CONDITIONS, not completed validation or release/SQL approval. See the fully unticked [database, browser and manual evidence list](OUTSTANDING-CHECKS.md).

N4 from #220 is mapped to the actual #247 candidate, including the type-only config loader and subsequent 145 policy/CI fixes, N1 paid breaks, both N2 key modes and owner caps, N3 Xero/Sage/QuickBooks, N5 blank guided setup, N6 email editing, exact-text chasing and inbound payment safety. The base revision is recorded in `manifest.json`. AK copies the pack and #248 manual checklist onto that base without merging implementation branches or changing application behaviour.

This is an evidence pack for the company's quality process, not certification or approval. Rhys is the validation lead and signs only after reviewing actual results. Protocol results below are filled only where current local evidence exists. All remaining rows are NOT TESTED. Decisions and VSR signature stay blank. Never use customer records or real keys in this public repository.

1. Rhys reviews the [URS](URS.md), [risks](RISK-ASSESSMENT.md) and [coverage gaps](COVERAGE-GAPS.md).
2. Code and Rhys complete [IQ](IQ.md) on the identified disposable installation.
3. Run [OQ](OQ.md), including its named tests and numbered [go-live manual checks](../MANUAL-CHECKS-GO-LIVE.md).
4. Company staff perform [PQ](PQ.md) using realistic fake work.
5. Reconcile [traceability](TRACEABILITY.md), deviations and evidence before Rhys fills the [VSR](VSR-TEMPLATE.md).

## Check the mapping and save current unit evidence

After installing the locked dependencies, from repository root:

```sh
npm run validate:pack
npm run validate:evidence
```

The first checks every URS/risk/OQ/PQ/IQ link, named test path, manual step and blank VSR count/signature. It does not execute tests. The second runs the static check then only the unique mapped `tests/unit/` files, explicitly through `vitest.config.ts`, with at most four workers. The original `node tests/validation/check-pack.mjs --run-unit` also calls this dated evidence runner. No database, Docker, schema installer, provider sandbox, browser or deployment command is provided. No arguments or arbitrary commands are accepted.

Each attempt creates `tests/validation/evidence/<UTC timestamp>-<commit>-<unique suffix>/`, with `summary.json`, `mapping.log` and, once started, `mapped-unit.log`. The summary identifies the tested commit, whether the checkout was dirty, Node/npm versions, SHA-256 hashes of mapped tests and pack/config/lock inputs, command exit codes, and exact pass/fail/skip/todo counts. Failed or incomplete attempts retain their logs and return a non-zero exit code. Skipped mapped unit cases, missing files, zero tests or a missing reporter result cannot pass. No environment variables or saved keys are dumped. Review logs before sharing; only synthetic data belongs in public evidence.

A dated log is evidence only for its command and inputs. It is not the full unit suite, an IQ/OQ/PQ completion, a live provider proof or validation approval. The older **119 tests** reported for #220 belong to that old revision and mapping; use the new run's count for this revision. Retain old evidence with the code it tested.

## Checks this command cannot complete

[COVERAGE-GAPS.md](COVERAGE-GAPS.md) explicitly lists the inbound-email automated gap on #247 and expanded SQL proofs still on draft follow-ups. Every URS has a real candidate test or a numbered manual check, but this does not prove every subcondition is automated or passed. IQ requires baseline through 144 followed by the reviewed 145 setup and 146 AI/cap inventory. The separately authorised operator prepares and tests the database; this pack never does so.

On a separately authorised disposable backend, Code must still run the full `npm run test:db`, the real two-session cap race, all reviewer database proofs after correct release sequencing, and the #245 browser checks once integrated. Browser/provider/manual work must use fake companies and controlled recipients. None was run by generating this pack. Do not replace those checks with unit mocks or silently accept a skip. Failed high-risk checks block release; unrun checks stay visible until Rhys reviews the evidence.

## CE frozen integration

The earlier CE code baseline was `d73bb240a23b38a7080c0933e4f5b62ddd529f5f`, stacking #272 to #275 on #247 (`41c685c416305637d86b580324fff9e6cda037ff`). The manifest now points to CI code checkpoint `0cc2463d0a6375ada1d65e249939efa02e3b3cf2`, which includes the command-exit gate fix. PR #280 records the actual final full reporting head and its checks externally; that head must match the release evidence gate. None of those drafts is merged. The original #258 owner branch is unchanged. This refresh copies its pack onto the tested integration for review. This is an assumption about review packaging, not a declaration that this is the final approved production SHA. Any integration change requires rerunning evidence. See CURRENT-RESULTS.md and RHYS-ACTIONS.md. Old dated logs retain their old commits and are historical only.

140 and 141 are REQUIRED for JNR. Real order: verified 138, 140, 141, verified 144, 145, 146; exclude 142/143. Test fixture baseline order is not proof of this real sequence.

CI follow-up keeps the new requirement/risk/OQ/PQ rows inside their actual Markdown tables and validates their column counts. All complete final-installation IQ/OQ/PQ results remain NOT TESTED. Earlier scoped local identification and unit results stay historical evidence, never substitute for final installation checks.
