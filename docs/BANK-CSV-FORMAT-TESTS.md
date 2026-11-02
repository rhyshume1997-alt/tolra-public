# Bank CSV format tests

These are made-up rows using representative Barclays, HSBC, Lloyds, NatWest,
Monzo and Starling headings. They are not customer statements or a guarantee
that every export offered by those banks is supported.

The added tests first reproduced 15 failures on the parent branch. The fix adds
missing header aliases, four-digit text-month dates, combined reference/name
text, and strict UK money grouping. It refuses a blank signed amount, a row
containing both credit and debit, and an unclosed quote. The quote guard overlaps
#131: consolidate that identical fix during integration.

Dates with two-digit years are still refused rather than guessing a century.
Currencies other than GBP are refused when the CSV has a Currency column.
A balance column is never used as a transaction amount. Matching remains a
suggestion: this branch does not record payments or change the matching rules.
