# Rhys's approved decisions

Source: Rhys's instructions in this session, 5 November 2026. These are scope decisions, not evidence of deployment or signed GO approval. Owner: Rhys. Technical execution stays with the named builder; ChatGPT independently reviews.

| Decision | Agreed rule |
| --- | --- |
| AI | AI is in and integrated. Production stays OFF until authorised; do not remove it or redesign it. |
| AI allowance | Settable **1000p (GBP 10) per company per calendar month**. One company's allowance must not affect another. #387 replaces the old required-£5 finding; legacy own-key 500p controls a separate company-supplied credential path. #399 is code/funding evidence, not a final policy choice. #404 gives Rhys a neutral note; whether to align both defaults remains UNPROVEN. No defaults/settings changed. |
| Cutover | Apply **138, 140, 141, 144, 145, 146, 147**, in order, then the approved JNR wipe, verify KEEP/Marpet/numbering holds, then the delivery-note counter. No production execution is authorised by this record. |
| Import/deployment positions | Rhys now specifies freeze before releases, then approved wipe/retained checks, no-writes preflight, import once/reconcile, DLN counter/verify, deploy exact approved SHA, smoke before staff access. ONE controlling runbook: #388 docs/runbooks/CONTROLLED-CUTOVER-2026-11-12.md. Failed dependencies STOP; never auto-restore. Operational approvals remain UNPROVEN. |
| DEV-001 | Add the held-company staff alert plus a plain message; preserve entered work and distinguish numbering hold from other errors. Code implements; #390 supplies red contracts. |
| Job profitability | New calculation OFF by default until John approves labour, machine and optional overhead rates, including labour/overhead inclusion flags. Keep the old calculation. |
| Xero/accounting | Finish and verify existing work; do not redesign it. No live transfers without approval. |
| Dates | GO decision **Monday 9 November 2026**; target go-live **Thursday 12 November 2026**. A target date is not permission to waive failed gates. |
| Safety/ownership | Separate draft PRs from main; no merge, production SQL, real data, private files or messages to John. Do not alter #359 or the go-live branch. One task, one owner; never reopen DONE without new evidence. |

Only Rhys can change release scope/authorisation. John/company management approve operating rates and company processes through the agreed route; no one signs for them here.
