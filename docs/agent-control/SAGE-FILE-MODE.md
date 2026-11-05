# Sage file mode

CODED / TESTED file workflow on main-based source. Admin > Integrations now explicitly says **Sage (file export)** and links to the existing authorised Settings year-end exporter. The generator is reused, not copied. Existing invoice summary, credit and payment CSVs retain their ISO dates, pennies, formula guards, unknown-payment blanks and reversal fields. This is an accountant handover format, not a promise that any Sage import wizard accepts it without mapping.

The unmerged public #221 adapter targets **Sage Business Cloud Accounting (Sage Accounting), Accounting API v3.1** for review-only invoice/balance lookup. It is not on main and is not enabled by this card. This file mode is not a Sage50/50cloud or Sage200 connector. No API, key, connection, transfer or migration is added. Product/version and importer mapping acceptance remain the accountant's decision.

READY FOR KEYS: not applicable to file export. CONNECTED: no online connector in this mode. MERGED / DEPLOYED / LIVE VERIFIED: UNPROVEN. DONE means coded file-mode labelling and tested existing format only; real accountant acceptance is unproven. No live calls, real data or John messages.

Reviewer follow-up5 November: SAFE WITH CONDITIONS reported by ChatGPT through Rhys. Label remains Sage (file export), no Sage connector added. Re-ran sage-file-export and all existing year-end unit suites:31 passed,0 failed,0 skipped. Evidence: tests/reviews/sage-file/evidence/reviewer-rerun.log. Owner Codex; accountant's exact Sage product/version and import mapping acceptance remain UNPROVEN; Code integrates and ChatGPT reviews. No live Sage/API test claimed.
