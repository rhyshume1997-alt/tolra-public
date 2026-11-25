# AI section redesign

The live `/ai-helper` route uses the confirmed company marker `ui-ai-v2:on` in `organization_settings.hidden_nav`. The legacy page renders while settings are pending, unavailable or missing that marker. Existing server and feature switches still control AI availability. Enable for the test company first after Rhys approves.

| Dependency | How the live redesign uses it |
| --- | --- |
| RoleGate | Same admin and office roles. |
| Organisation settings | Same confirmed company rollout reader as Reports. |
| AI status | Uses the existing scoped status hook, reload and `anyFeatureOn`. Each view maps the same feature fields to the panels. |
| Round-up, RFQ and Assistant | Mounts the existing panels with scoped presentation changes. Requests, validation, draft approvals, links and result actions stay in their existing components. |
| Setup | Links to the existing Admin Integrations AI card for eligible users. |
| Presentation | The new component owns the header, setup callout, loading, off and error states. |

Local Chromium verified both layouts at 360, 390, 768 and 1024 CSS pixels using the real route and panels with fixture session and status responses. It covered AI off, loading, failure and retry, and enabled tools. The checks exercised the RFQ form without sending a request to an AI provider.
