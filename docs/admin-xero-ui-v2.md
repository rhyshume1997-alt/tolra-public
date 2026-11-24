# Xero organisation redesign

The live `/admin/integrations/xero-organisation` route selects the new presentation with `ui-admin-xero-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same admin gate, organisation-offer request, CSRF value, chosen organisation, authenticator-code prompt and connection endpoint. |
| Presentation | Shared header, loading, error and chooser presentation. The live connection handler is unchanged. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The organisation offer was empty, delayed, failed or populated. Chromium selected a fixture organisation and checked the Connect button state. No Xero endpoint was contacted.
