# Settings redesign

The live `/settings` route selects the new presentation with `ui-settings-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin gate, company settings store and setters, independent settings panels, forms and audit. |
| Presentation | Shared header and links to existing section anchors. Document Designs renders as its original component outside the scoped panel styles. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The scenarios covered an empty, delayed, failed or populated company profile read. Successful hydration used the existing company profile loader. Document Designs uses its existing component and controls.
