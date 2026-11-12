# Rhys: register the Xero app

**The domain comes first.** Finish the approved C10 domain checks before saving production callback addresses. `https://tolra.co.uk` must be the working HTTPS site; Vercel Production `NEXT_PUBLIC_SITE_URL`, Supabase Auth URLs and the approved deployment must agree. Do not register a temporary Preview address and hope the live callbacks will change themselves.

Use Xero's developer account/app registration and demo organisation for the free development route. Do **not** buy a paid Custom Connection or a subscription in this job. Developer registration/demo testing does not promise free or unrestricted production access. Rhys checks the portal's current price, connection limit and terms at the time of registration; if payment/production approval is required, STOP and record the decision rather than subscribing. Portal screens/terms were not checked live by this builder.

| Step | Do this | You should see / copy |
| --- | --- | --- |
| 1 [ ] | Open https://developer.xero.com/ with the approved business-owned login; protect it with its own sign-in code. Open **My apps** and the new-app/register flow. | Correct owner; free development route selected. No personal/customer login borrowed. |
| 2 [ ] | Enter app name Tolra, company/home page https://tolra.co.uk and choose the standard OAuth 2.0 web/confidential-server application, not Custom Connection. | A saved developer app with a client ID; no paid purchase. If labels/type differ, check Xero's current web-app guidance before proceeding. |
| 3 [ ] | Register the two exact callbacks below. Prefer copying the matching addresses shown by Tolra's **Platform → App connections** Xero card after the domain is correct. | https://tolra.co.uk/api/integrations/xero/callback and https://tolra.co.uk/api/integrations/invite/callback; no trailing slash, query or Preview hostname. |
| 4 [ ] | Check the scopes required by the frozen code against the portal's current scope names. | `offline_access`, `accounting.invoices`, `accounting.contacts`, `accounting.settings.read` in the reviewed code. New apps use granular scopes; if unavailable/refused, STOP for a reviewed compatibility decision. Do not add broader bank/payment scopes to make it work. |
| 5 [ ] | Generate the client secret. In Tolra, sign in as the platform owner, confirm your authenticator and open the Xero card in **Platform → App connections**. Paste into **Client id** and **Client secret**, then **Save**. | ID goes to Client id; secret **value** goes to Client secret. Saved secret is not shown again. Do not paste either into this public form. |
| 6 [ ] | Code verifies the existing server encryption setup and approved configuration. | `INTEGRATIONS_ENCRYPTION_KEY` exists privately; keep the existing key, never replace it to get past a failure. Stored app credentials take precedence over env fallback. No ordinary company user receives the secret. |
| 7 [ ] | If the approved deployment intentionally uses environment fallback instead of saved credentials, Code sets the exact server-only values below in the intended Vercel environment and deploys under separate approval. | `XERO_CLIENT_ID` ← client ID; `XERO_CLIENT_SECRET` ← secret value; `XERO_REDIRECT_URI` ← normal callback above. Remove/resolve a stale stored row only through approved controls; do not assume env overrides it. |
| 8 [ ] | Use **Test connection** with the safe Xero demo organisation. Return to Tolra. Then test ordinary and accountant-invite callbacks with controlled accounts under the approved rehearsal. | “Xero app works” or an explicit error. App test is not a company's Connect and does not approve an export. Both callback paths need actual proof. |
| 9 [ ] | An authorised company admin chooses **Connect to Xero** in Integrations, consents to the correct demo organisation and checks its name. Separately test each fake company; never reuse one Xero organisation across companies to bypass isolation. | Correct company connection. No unexpected automatic send. Mapping/explicit export approval and provider-isolation proofs remain required before live use. |

Keep the secret in the approved secret manager; record only app name/owner, callback addresses, creation/expiry date and private evidence reference. On mismatch, check exact callback/ID/secret expiry/account; never print the token. Current portal pricing/terms checked by/date/private reference: ____.

Result: [ ] DEVELOPMENT PROOF COMPLETE [ ] FAILED [ ] NOT RUN. Production decision remains separate.

Rhys name/signature/date: ____  Code/checker name/date: ____

Blank master, prepared 4 November 2026. Fill and sign a private copy. An empty box is not approval. Keep phone numbers, customer records, keys and signatures out of the public repository.
