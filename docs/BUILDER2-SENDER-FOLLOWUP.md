# Payment email sender follow-up (job 18)

Suggestions now require one syntactically valid sender address matching the invoice customer's recorded mailbox. Blank, malformed, multi-address and mismatched senders produce no suggestion, even with a named invoice. Repeated messages do not duplicate a suggestion. The newer detector from #137 is copied here so prefix/future-payment fixes are not lost during integration.

An address match is not cryptographic proof of the sender. This helper has no provider authentication headers; messages can be spoofed. Suggestions still require human review and bank confirmation. It never records a payment or changes a claim automatically. The caller must supply only the current company's emails/invoices.

The staff guide also incorporates #139's correct £100 + 20% = £120 wording and the chosen-days timesheet controls. JNR must still fill the first-day contact card; no phone number was invented.
