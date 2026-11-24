# Operations Reports redesign

The existing `/reports` route uses `ui-reports-v2:on` in the company’s `organization_settings.hidden_nav`. Both that marker and `reports:on` must be present in a successful server read for the active user and company. A missing marker, a pending read or a failed read selects the legacy route body. A fresh read is required after a switch value changes. Enable for the test company first after Rhys approves.

| Dependency | How the live redesign uses it |
| --- | --- |
| RoleGate | Same admin and office gate around both views. |
| Organisation settings | Same scoped server query, subscription and reset. The rollout uses the confirmed server snapshot, excluding browser fallback and optimistic values. |
| Report loading and controls | Both views use `useReportsData` for period, retry and request lifecycle, with the existing `loadReports` and its section restrictions, calculation and truncation rules. |
| Report cards and exports | Both views use the same four report cards, figures, empty states and CSV/XLSX export handlers. |
| Revenue link | Both views use the existing role and revenue switch predicates. |
| Presentation | The new view supplies its own header, period controls and card frames. Both frames present the same hidden-section, failure, note and truncation states. |

Local Chromium verified redesign OFF and ON at 360, 390, 768 and 1024 CSS pixels, with empty, pending, failed and populated report reads. The checks used the real route, role gate, settings store, reports loader and styles with a fixture session and database response. They also exercised retry, changing the report period, company isolation and fallback from cached settings. The authenticated deployment and production data were outside the local check.
