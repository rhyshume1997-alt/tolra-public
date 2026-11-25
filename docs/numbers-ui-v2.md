# Numbers redesign

The live `/numbers` route selects the new presentation with a confirmed company marker `ui-numbers-v2:on` in `organization_settings.hidden_nav`. Pending and failed reads select the legacy view. Enable for the test company first after Rhys approves.

| Dependency | How the live redesign uses it |
| --- | --- |
| Admin restriction | Both views share the same active-role check and dashboard redirect. |
| Data, time window and retry | Both views use the original queries, calculations, periods and retry state in `useNumbersView`. |
| Charts and bar lists | Both views use the same cash chart and bar list components. |
| Presentation | New header, period control, panels and states use shared UI components. The cash table presents the same computed rows. |

Local Chromium verified OFF and ON at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. Checks rendered the live route with local session and database fixtures.
