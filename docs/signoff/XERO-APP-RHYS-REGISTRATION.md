# Rhys: register Tolra with Xero

**The domain comes first.** Complete C10's website checks: https://tolra.co.uk works securely, the live Vercel deployment (`NEXT_PUBLIC_SITE_URL=https://tolra.co.uk`) and Supabase sign-in addresses agree, and the approved app version is running. Buying the domain alone is not enough. Do not use a temporary Preview address for the live connection.

Use a business-owned developer login and a Xero demo company. Use free development access only. Do not buy **Custom Connection**, a subscription or an upgrade here. A free developer account does not promise free/unrestricted live use. Rhys must check today's portal prices, limits and terms; if payment or further approval is needed, STOP and record it. Portal details were not checked live by this writer.

A **callback/redirect address** is where Xero returns you after its sign-in. It must match exactly. A **client ID** identifies Tolra's registered app; a **client secret** is its private password. Never put the secret on this form or in a public screenshot.

| Tick | Rhys does this, with technical help | What he should see |
| --- | --- | --- |
| [ ] | Open https://developer.xero.com/, sign in with the approved business login and use **My apps** to register a new app. Protect that login with its own code. | Correct owner and free development route; no borrowed customer account. |
| [ ] | Name it Tolra; website https://tolra.co.uk. Choose Xero's standard **OAuth 2.0 web/confidential-server app** type. This means the website keeps the secret and Xero handles sign-in. Do not select paid Custom Connection. | App saved with a client ID. If labels differ, check current Xero web-app instructions with the technical person. |
| [ ] | Register both exact return addresses below. Copy the same addresses from Tolra's **Platform → App connections** Xero card after the domain is ready. | No extra slash, query or Preview hostname. |
| [ ] | Technical person compares the permissions the app asks for with Xero's current names. | Permission names below match the approved code and portal. If a name is unavailable, STOP for review; do not add broader bank/payment permissions. |
| [ ] | Generate the secret. As Tolra's platform owner, confirm your code, open that Xero card, paste ID into **Client id**, secret value into **Client secret**, then **Save**. | Secret saved and not shown again. The technical person confirms existing encryption setup works. |
| [ ] | Use **Test connection** with the demo company. Separately try the normal and accountant-invite return paths under the agreed practice plan. | “Xero app works” or an explicit error. This app test does not connect a shop or approve an export. Both paths need actual results. |
| [ ] | A test-company admin uses **Connect to Xero**, chooses the right demo company and checks its displayed name. Repeat separately for the other test company. | Correct separate company connections, no secret shown and no unexpected send. One Xero company cannot be reused across Tolra companies to bypass separation. Account mapping/export approval and company/provider checks remain required. |

Exact return addresses:

- Normal: `https://tolra.co.uk/api/integrations/xero/callback`
- Accountant invite: `https://tolra.co.uk/api/integrations/invite/callback`

**Technical person's copy list:** required code permissions are `offline_access`, `accounting.invoices`, `accounting.contacts`, `accounting.settings.read`; verify current granular-scope names. Keep existing `INTEGRATIONS_ENCRYPTION_KEY` private and unchanged. Saved platform credentials win over environment settings. Only if the approved setup intentionally uses environment fallback, set server-only Vercel `XERO_CLIENT_ID` ← ID, `XERO_CLIENT_SECRET` ← secret value, `XERO_REDIRECT_URI` ← normal address above; separately approve/publish that deployment. Resolve stale saved credentials through approved controls; changing environment values does not override them.

Save secrets only in the approved password/secret store. Record app owner, addresses, secret creation/expiry and private test report. If connection fails, check address, ID, secret expiry and account; never print tokens.

Current terms/prices checked by/date/report: ____.

Result: [ ] DEVELOPMENT CHECKS COMPLETE [ ] FAILED [ ] NOT RUN. Live use needs its separate decision.

Rhys signature/date: ____  Technical person/checker name/date: ____

Blank master, prepared 4 November 2026. Complete/sign a private copy. Empty boxes are not approval; this writing job performed none of the actions above.
