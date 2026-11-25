# RFQ redesign

The live `/rfq` route selects the redesign through `ui-rfq-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed reads select the legacy view. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | The same admin and office gate, intake counts, quote linking, status and stage filters, record cards, dialogs and mail permissions. |
| Presentation | The new header, count tiles and list states use shared UI components. The existing handlers apply each filter and handle draft, quote, reply, forward and clarification actions. |

Local Chromium verified both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. The live route used local session and database fixtures.
