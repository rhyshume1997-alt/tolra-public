# User requirements

Company: ____  Intended use: ____  Release/commit: ____  Approved before testing by Rhys / date: ____

Based on the final candidate `claude/247-final` at `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8` (#247 plus the #245 reviewer browser specs, the #253 inbound and #255 chasing proofs, SliQ releases 140/141 and the CI reinstall of 145/146). Imported from N4 #220; manual checks come from #248 with AK additions. This is a mapping, not executed IQ/OQ/PQ evidence.

| ID | Requirement | Accepted by / date |
| --- | --- | --- |
| URS-001 | Signed-in people see only their own company’s records. | ____ |
| URS-002 | Only people with the right role may perform restricted actions. | ____ |
| URS-003 | Money calculations keep exact pence and handle rounding consistently. | ____ |
| URS-004 | A draft invoice does not count as an issued invoice or an approved payment. | ____ |
| URS-005 | Reopening a finished job requires confirmation, approval handling and a recorded reason. | ____ |
| URS-006 | Hours use the saved company break rule; JNR starts with unpaid breaks. | ____ |
| URS-007 | The print pack uses the selected company layout and matching document totals. | ____ |
| URS-008 | Important changes have a who, what and when record. | ____ |
| URS-009 | Xero, Sage and QuickBooks keep encrypted tokens, company records and provider results separate; exports require connection, mappings and a permitted action. | ____ |
| URS-010 | AI is off until allowed; own-key and Tolra-provided modes never share keys; only Rhys with MFA sets each company cap (default 1000p, maximum 100000p); concurrent reservations never exceed it; suggestions need a person. | ____ |
| URS-011 | N5 creates a blank company and saves the guided setup only for its own admins, across existing Settings, Users, Integrations and Import pages. | ____ |
| URS-012 | N6 uses labelled subject, greeting, main message and sign-off boxes, detail buttons and an example preview for chase and timesheet templates; old saved text stays exact and read-only staff cannot save. | ____ |
| URS-013 | Chasing sends only the exact approved recipient, subject and body once; edits invalidate approval; ambiguous customer names refuse at draft creation and approval; uncertain delivery never automatically resends. | ____ |
| URS-014 | Customer paid claims and inbound paid/remittance/payment-sent emails never record a payment or change invoice paid fields, balance or status automatically. | ____ |
