# Dashboard redesign

The live `/dashboard` route selects the redesign through `ui-dashboard-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads select the existing page. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Existing role-specific dashboard loaders, figures, column preferences, navigation and cards. |
| Presentation | Shared header, section styling, jump links, and a layout for the Today breakout. |

The full 360, 390, 768 and 1024 CSS-pixel OFF/ON matrix used the workshop view with empty, loading, error and populated fixtures. Chromium smoke checks also covered admin, office and viewer. Unit tests covered company isolation.
