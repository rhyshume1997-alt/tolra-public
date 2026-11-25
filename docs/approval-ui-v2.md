# Approval Queue redesign

The live `/approval` route selects the redesign through `ui-approval-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads select the existing page. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin/office gate, draft query and cards, history, held-email and reopen approvals, edit/preview and send confirmations. |
| Presentation | New header, provider notice and queue states. |

Chromium verified both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixtures, retry and company isolation. The checks used a fixture session and database responses.
