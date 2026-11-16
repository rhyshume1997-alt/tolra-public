# Extra payment-claim examples

Thirty made-up UK messages cover completed BACS payments, Friday payments,
settled invoice references, copy requests, future promises and questions.
Twenty-one cases failed before the fix. The same expectations now pass.

The helper now recognises the added completed-payment phrases, rejects the
added question/future/conditional cases, and matches whole invoice references
rather than a prefix of another reference. Existing tests are unchanged.

This is still a suggestion helper, not proof of payment. It never records
money or changes an invoice. Sender verification and the blank-sender issue in
#117 remain outside this branch. Integrate this detector into copied adapters
explicitly so an old detector is not silently restored.
