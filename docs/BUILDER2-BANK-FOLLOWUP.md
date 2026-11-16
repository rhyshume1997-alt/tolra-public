# Bank follow-up (job 18)

Manual confirmation now waits for the callback, locks other actions, retains a failed row and blocks confirmation while any CSV row is invalid. A deterministic version-5-shaped request UUID is reused for the same file, row and invoice, including reupload. The optional adapter passes that UUID to the existing record_invoice_payment RPC; no raw invoice/payment table update is used.

Whole-reference matching refuses a short reference inside a longer one. A conflicting explicit invoice reference prevents fallback to a customer-name suggestion. Non-integer and unsafe pence do not match.

No live bank page or automatic payment posting was introduced. A caller must connect the manual callback to recordConfirmedBankPayment (or an equivalent authorised, idempotent path). The parent must supply only its current company's invoices. Different exports containing the same real bank transaction still need bank-transaction identity/reconciliation; an identical-file retry key cannot prove cross-export uniqueness. Existing database role/company/payment checks remain authoritative. Live database/browser checks remain required.
