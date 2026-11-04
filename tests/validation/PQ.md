# PQ: can the company complete its real working day?

Use realistic fake work in the approved test environment. The company's process owner performs these steps; a developer's unit log cannot replace this acceptance. Use fake email recipients and provider sandbox accounts. Nothing may be sent externally without a named tester approving it.

| Step | Action | Expected result | Pass / Fail / Not run | Actual result / evidence | Tester / date |
| --- | --- | --- | --- | --- | --- |
| PQ-001 | Work as company A then B using the same fake customer and PO numbers. Try the restricted actions with each role; switch companies and repeat. | Company records stay separate and permissions remain correct. | ____ | ____ | ____ |
| PQ-002 | Make a fake customer quote with quantity, customer PO and VAT. Follow the normal job and draft-invoice flow. Check saved and printed pence against an independent calculation. | Records stay linked, totals agree, and a draft is not an issued invoice or payment. | ____ | ____ | ____ |
| PQ-003 | Clock a fake shift, record a problem, finish and reopen the job through confirmation, print its pack, inspect audit. Repeat with paid and unpaid breaks. | Hours agree with the company's rule, chosen pack is usable, reopen approval/notification and audit can be explained. | ____ | ____ | ____ |
| PQ-004 | With accounting and AI off, attempt their actions. With approved sandbox setup only, verify mapping and human review gates. Stop before any unapproved send. | Off stays off; nothing is sent without setup, mappings and the required person's action. | ____ | ____ | ____ |
| PQ-005 | Owner reviews every URS traceability row, failed/not-run step and deviation. Record staff feedback. | No unexplained gap; release decision and any limits are signed by the owner. | ____ | ____ | ____ |
| PQ-006 | Create the blank company and follow the saved setup across settings, users, integrations and import. Try both template editors, detail buttons, previews, legacy text and read-only access. | New business lists are blank; only own admins save setup; old email text stays exact and no preview sends. | ____ | ____ | ____ |
| PQ-007 | Edit/review the ZZ chase, invalidate stale approval, test duplicate-name refusal, double send, uncertain delivery and inbound paid phrases. | Only exact approved text sends once to the correct person; uncertain delivery never resends; no email marks invoices paid. | ____ | ____ | ____ |
| PQ-008 | Compare both AI key modes and separate company caps, then Xero/Sage/QuickBooks connections, token privacy, mappings and results. Obtain real cap race evidence. | Modes/providers/companies stay separate; only Rhys with MFA changes provided caps; no over-cap reservation or unapproved export occurs. | ____ | ____ | ____ |

Numbered rehearsal sources: PQ-001: G01.4, G08.5; PQ-002: G01.2, G01.3, G13.1; PQ-003: G04.2, G13.2, G13.3, G13.4; PQ-004: G05.1, G06.3; PQ-005: G14.1; PQ-006: G08.3, G08.4, G10.1, G10.3; PQ-007: G02.4, G02.6, G03.4, G10.2, G11.1, G11.2; PQ-008: G09.3, G09.4, G12.2, G12.3, G12.4. See TRACEABILITY.md.
