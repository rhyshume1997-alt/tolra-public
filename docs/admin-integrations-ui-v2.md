# Integrations redesign

The admin-only route `/admin/integrations` selects the redesign with a confirmed company marker `ui-admin-integrations-v2:on` in `organization_settings.hidden_nav`. Pending or failed settings reads select the legacy layout.

The shared header and panel styling are presentation changes. The route renders the existing controls and their original reads, validation, permissions and mutation handlers. The rollout remains subject to Rhys’s approval, starting with the test company.

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. Microsoft 365 used local disconnected, delayed, failed and connected status responses. No provider connection or send action was invoked.
