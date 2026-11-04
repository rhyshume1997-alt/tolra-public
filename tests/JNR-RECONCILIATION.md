# CC: offline JNR comparison

Assumption: this supplements the existing SliQ reconciliation tool without changing its owner's importer or rounding policy. It is not a database extractor or release approval.

Run `node scripts/jnr-reconcile/cli.mjs /private/path/snapshots.json`. It reads one local file and prints a redacted summary. It cannot connect, update, delete or import anything. Exit 0 means the supplied snapshots match; 1 means mismatch or incomplete data; 2 means invalid file. Keep source files outside Git.

The input contract is demonstrated by `tests/unit/jnr-reconcile.test.ts`: `company`, `protectedCompany`, `expected`, `actual`, `protectedInventory`, `preservationBefore`, `preservationAfter`. Expected and actual each contain customers, invoices, payments, jobs and numbering. Every row has an explicit company and stable sourceRef; names are never identity. Invoice fields are original totalPence, paidPence, creditPence and refundPence; payments must independently sum to paidPence. No mutation of the original invoice total. All amounts and next numbers are integer strings. No float, decimal rounding or missing-as-zero is permitted. Separate credit/refund records require their reviewed source export; negative invoice totals are refused.

Calculated fractional pence can be normalised using the separately tested `halfEven(numerator, denominator)` helper before constructing a source report. Do not round exported invoice totals or change application rounding.

Preservation snapshots contain complete Marpet tables from a reviewed protectedInventory plus logins, settings, numbering and audit. Missing categories, foreign company rows and table inventory mismatches refuse. The comparison covers every supplied field and row, including empty tables. A reviewer must still prove the inventory is complete and the snapshots came from the intended backup and database, record their exact commit, hashes and extraction times, and independently confirm next document numbers exceed existing imported numbers. This offline tool cannot establish those facts or SQL permissions. No real JNR or Marpet data has been used.

Release gate artifacts must wrap this result with actual id, commit and recordedUtc; a matching fake fixture is never production evidence. Ownership and handover: coordination PR #271.
