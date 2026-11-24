# Purchase Orders redesign

The live `/purchase-orders` route selects the new presentation with `ui-purchase-orders-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Existing admin/office gate, supplier eligibility, reads, saves, VAT, records linked to jobs or quotes, receipts, supplier email, PDF and attachment handlers. |
| Presentation | Shared header, summary tiles and list states. Existing table, controls and dialogs are reused. |

Local Chromium covered both layouts at 360, 390, 768 and 1024 CSS pixels with empty, loading, error and populated fixture responses, plus retry and company isolation. The local Chromium matrix opened purchase order details through the real route using fixture data.
