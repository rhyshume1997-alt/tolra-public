# Email and Payment Automation redesign

The live `/email` route selects the redesign through `ui-email-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed reads show the existing page. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin and office gate, history read, filtering, counts, role restriction for settlement and existing settlement endpoint. |
| Presentation | The new view supplies the header, filter tiles, responsive history and status states. The message dialog and settlement controls show the existing content and invoke the existing actions. |

Local Chromium verified both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. The checks used the live route and stubbed session and database responses.
