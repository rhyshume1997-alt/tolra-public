# User Management redesign

The admin-only route `/admin/users` selects the redesign with a confirmed company marker `ui-admin-users-v2:on` in `organization_settings.hidden_nav`. Pending or failed settings reads select the legacy layout.

The shared header and panel styling are presentation changes. The route renders the existing controls and their original reads, validation, permissions and mutation handlers. The rollout remains subject to Rhys’s approval, starting with the test company.

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The existing users list was exercised through empty, delayed, failed and populated member fixture reads. Retry was exercised without calling a real admin write or email endpoint.
