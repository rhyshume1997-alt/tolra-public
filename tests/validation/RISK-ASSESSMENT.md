# Risk assessment

Based on draft #247 at `fe7514fbea7eaac2fead0237db0fa7d2abcc6db8`, including its config-loading fix. Imported from N4 #220; manual checks come from #248 with AK additions. This is a mapping, not executed IQ/OQ/PQ evidence.

High means wrong money, disclosure, permission or an untraceable change. The process owner approves likelihood and remaining risk. Any failed high-risk check blocks release.

| Risk | Requirement | What could go wrong | Impact | Control / proof | Likelihood before / after | Remaining risk accepted by / date |
| --- | --- | --- | --- | --- | --- | --- |
| RISK-001 | URS-001 | Wrong company sees private records | High | OQ-001, G01.4, G08.2, G08.5; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-002 | URS-002 | Staff can approve or administer without permission | High | OQ-002, G07.2, G07.4, G08.5; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-003 | URS-003 | Incorrect invoice or credit totals | High | OQ-003, G01.2, G01.3, G13.1; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-004 | URS-004 | Draft changes alter money owed | High | OQ-004, G01.2, G01.3, G13.1; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-005 | URS-005 | Work restarts without a trace | High | OQ-005, G13.2; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-006 | URS-006 | Incorrect paid hours | High | OQ-006, G04.1, G04.2, G04.3; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-007 | URS-007 | Wrong drawing or paperwork reaches the floor | Medium | OQ-007, G13.3; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-008 | URS-008 | Company cannot explain a change | High | OQ-008, G13.4; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-009 | URS-009 | Leaked tokens, mixed company/provider records or duplicate accounting exports | High | OQ-009, G06.1, G06.2, G06.3, G06.4, G09.1, G09.2, G09.3, G09.4; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-010 | URS-010 | Cross-company key disclosure, unauthorised cap changes or overspending | High | OQ-010, G05.1, G05.2, G05.3, G05.4, G05.5, G12.1, G12.2, G12.3, G12.4; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-011 | URS-011 | Another company data or unauthorised setup progress appears | High | OQ-011, G08.1, G08.2, G08.3, G08.4, G08.5; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-012 | URS-012 | Template editing changes legacy email text or allows unauthorised changes | High | OQ-012, G10.1, G10.2, G10.3, G10.4; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-013 | URS-013 | Wrong customer or unapproved/duplicate message is sent | High | OQ-013, G02.1, G02.2, G02.3, G02.4, G02.5, G02.6, G11.1, G11.2; mapped tests in OQ. | ____ / ____ | ____ |
| RISK-014 | URS-014 | An email incorrectly clears a real debt | High | OQ-014, G03.1, G03.2, G03.3, G03.4; mapped tests in OQ. | ____ / ____ | ____ |
