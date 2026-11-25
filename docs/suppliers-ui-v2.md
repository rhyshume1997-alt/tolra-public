# Suppliers redesign

The live `/suppliers` route selects the redesign through `ui-suppliers-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed reads show the existing page. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin/office gate, server reads and writes, field validation, audit, exports, status editing and contact form. |
| Presentation | Shared responsive cards/table and More actions. The route supplies existing callbacks and editor content to both layouts. |

Local Chromium verified OFF and ON at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. Checks rendered the live route with local session and database fixtures.
