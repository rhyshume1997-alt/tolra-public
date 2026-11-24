# Jobs redesign

The live `/jobs` route selects the new presentation with `ui-jobs-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same role and view checks, board filters and grouping, rows, details and print, job actions, inspection, rework, worksheets and existing offline hooks. |
| Presentation | Shared page header and panel styling. The same job board markup and forms render under either header. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The browser exercised the real Job Board with empty, delayed, failed and populated reads, plus retry, company isolation and opening the secondary filters. The Jobs filters keep their original state and callbacks.
