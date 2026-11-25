# Security redesign

The admin-only route `/admin/compliance` selects the redesign with a confirmed company marker `ui-admin-security-v2:on` in `organization_settings.hidden_nav`. Pending or failed settings reads select the legacy layout.

The shared header and panel styling are presentation changes. The route renders the existing controls and their original reads, validation, permissions and mutation handlers. The rollout remains subject to Rhys’s approval, starting with the test company.

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. Audit log fixtures exercised empty, delayed, failed and populated reads and refresh. The test alert action was not invoked.
