# Quotes redesign

The live `/quotes` route selects the new presentation with `ui-quotes-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin/office gate, query and save functions, RFQ links, status summaries and list, pricing and VAT logic, validation, sending and quotation dialogs. |
| Presentation | Shared page header and panel styling. The route uses the same list and dialogs for both layouts. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The browser exercised the real quotes list with empty, delayed, failed and populated queries, plus retry and company isolation.
