# Data redesign

The admin-only route `/admin/data` selects the redesign with a confirmed company marker `ui-admin-data-v2:on` in `organization_settings.hidden_nav`. Pending or failed settings reads select the legacy layout.

The shared header and panel styling are presentation changes. The route renders the existing controls and their original reads, validation, permissions and mutation handlers. The rollout remains subject to Rhys’s approval, starting with the test company.

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The importer was exercised with no file, a delayed file read, an invalid file and a populated CSV review. No import was committed.
