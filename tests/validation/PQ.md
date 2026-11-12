# PQ: can the company complete its real working day?

Use realistic fake work in the approved test environment. The company's process owner performs these steps; a developer's unit log cannot replace this acceptance. Use fake email recipients and provider sandbox accounts. Nothing may be sent externally without a named tester approving it.

| Step | Action | Expected result | Pass / Fail / Not run | Actual result / evidence | Tester / date |
| --- | --- | --- | --- | --- | --- |
| PQ-001 | Work as company A then B using the same fake customer and PO numbers. Try the restricted actions with each role; switch companies and repeat. | Company records stay separate and permissions remain correct. | ____ | ____ | ____ |
| PQ-002 | Make a fake customer quote with quantity, customer PO and VAT. Follow the normal job and draft-invoice flow. Check saved and printed pence against an independent calculation. | Records stay linked, totals agree, and a draft is not an issued invoice or payment. | ____ | ____ | ____ |
| PQ-003 | Clock a fake shift, record a problem, finish and reopen the job through confirmation, print its pack, inspect audit. Repeat with paid and unpaid breaks. | Hours agree with the company's rule, chosen pack is usable, reopen approval/notification and audit can be explained. | ____ | ____ | ____ |
| PQ-004 | With accounting and AI off, attempt their actions. With approved sandbox setup only, verify mapping and human review gates. Stop before any unapproved send. | Off stays off; nothing is sent without setup, mappings and the required person's action. | ____ | ____ | ____ |
| PQ-005 | Owner reviews every URS traceability row, failed/not-run step and deviation. Record staff feedback. | No unexplained gap; release decision and any limits are signed by the owner. | ____ | ____ | ____ |
