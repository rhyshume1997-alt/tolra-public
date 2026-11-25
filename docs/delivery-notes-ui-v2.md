# Delivery Notes redesign

The live `/delivery-notes` route selects the new presentation with `ui-delivery-notes-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Existing admin/office/workshop roles, workshop source restrictions, status and phase filters, notes from order or job, email eligibility, invoice links, signing, prints and attachments. |
| Presentation | Shared header, summary tiles and list states. Existing table and all dialogs are reused. |

Local Chromium covered both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. The local Chromium matrix included opening a note detail. It used no documents belonging to a real company.
