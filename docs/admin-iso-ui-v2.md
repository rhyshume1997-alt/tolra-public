# ISO templates redesign

The live `/admin/iso` route selects the new presentation with `ui-admin-iso-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin gate and independent ISO templates feature switch. Reuses existing evidence and company reads, limit handling, draft PDF and zip generation, NCR reminder and gap checklist. |
| Presentation | Shared header and loading panel. Existing documents, checklist and reminder are passed as children. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The evidence was empty, delayed, failed or populated. The legacy ISO screen has existing horizontal overflow at 360 and 390 CSS pixels and keeps its existing layout. The opted-in layout fits both widths.
