# Machine Schedule redesign

The live `/schedule` route selects the new presentation with `ui-schedule-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same roles, live refresh, booking and machine permissions, saved dates, timeline and booking dialogs. |
| Presentation | Shared page header and panel styling. The existing Gantt, live machine indicators and actions are reused. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The existing timeline was exercised with empty, delayed and failed reads and a populated machine list, plus retry and company isolation.
