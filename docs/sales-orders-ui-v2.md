# Sales Orders redesign

The live `/sales-orders` route selects the new presentation with `ui-sales-orders-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Existing SalesOrdersGate, admin/office roles, counts, view and column settings, selection, archiving, accepted-quote loading, PO assignment, machine planning, conversion to jobs, despatch, printing and exports. |
| Presentation | Shared header, interactive count tiles, retry, loading and empty states. Existing table, actions and dialogs carry through. |

Local Chromium covered both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. The Chromium matrix included the existing feature gate and opened an order detail. Conversion, despatch and document actions were not triggered.
