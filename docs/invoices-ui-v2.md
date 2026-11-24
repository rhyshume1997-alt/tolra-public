# Invoicing redesign

The live `/invoices` route selects the new presentation with `ui-invoices-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin/office gate, filters, controls, invoices, VAT, payments, allocations, credit notes, reminders, creation and issue flows. |
| Presentation | Shared title and scoped panel styling. Existing draft and customer-credit notices, actions and dialogs are reused. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The browser exercised the real invoice list with empty, delayed, failed and populated queries, plus retry and company isolation.
