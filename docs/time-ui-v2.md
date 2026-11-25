# Weekly hours redesign

The live `/time` route selects the new presentation with `ui-time-v2:on` in confirmed company `organization_settings.hidden_nav`. Pending and failed settings reads use the existing presentation. Enable for the test company first after Rhys approves.

| Dependency | How the redesign uses it |
| --- | --- |
| Reused | Same Today and This week sheets, time and break rules, queries, corrections, payroll exports, approvals and role visibility. |
| Presentation | Shared title and layout on both tabs and the loading fallback. Print routes continue to render the existing sheets. |

Local Chromium checked both layouts at 360, 390, 768 and 1024 CSS pixels. The Today and This week tabs each used empty, delayed, failed and populated attendance fixtures. Retry was exercised in both; the rollout test checked company isolation.
