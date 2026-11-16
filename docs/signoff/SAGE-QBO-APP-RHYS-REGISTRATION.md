# Rhys: register Sage and QuickBooks

**The domain comes first.** Complete C10's approved HTTPS/DNS/Vercel/Supabase checks for `https://tolra.co.uk`, then register the exact callbacks. Domain registration alone is not enough; the deployed site and callback routes must work. Recheck URLs after any domain change.

Use free developer/test access where offered. Registration/sandbox access is separate from a paid accounting subscription or approval to use live accounts. Do not buy anything or submit paid upgrades as part of this sheet. Check current portal terms, region, limits and whether a test company is available; STOP if payment or an unavailable test account blocks free development. No portal/pricing/account was checked live by this builder.

## Sage: Accounting cloud API, not desktop Sage

1. [ ] Open https://developer.sage.com/ using the approved business-owned login. Follow the **Accounting** developer/get-started route to register a confidential web application. Choose the region/product that matches the approved Sage Accounting cloud test business. **See:** an app registration for the cloud Accounting API; desktop Sage 50 is not this adapter.
2. [ ] Name it Tolra and enter https://tolra.co.uk as the home/site URL. Register **https://tolra.co.uk/api/accounting/sage/callback** exactly. **See:** saved callback with no query, trailing slash or Preview hostname.
3. [ ] Copy the app's client ID and client-secret value into the approved secret manager. Code sets server-only Vercel settings in the agreed environment: `SAGE_CLIENT_ID` ← ID; `SAGE_CLIENT_SECRET` ← secret value; `SAGE_REDIRECT_URI` ← callback above. **See:** configured variables by name; no secret in browser/public files. The current app-credentials screen supports Xero/Microsoft, so do not look for a Sage secret box there.
4. [ ] Review the consent scope: the current adapter requests **full_access**. **See:** Sage's actual permission wording. That scope is broader than Tolra's current read-only payment-check behaviour; John/Rhys must accept the real provider grant. If unacceptable, leave Sage off and obtain a reviewed scope decision; do not claim Sage enforces read-only consent.
5. [ ] Code verifies the existing encryption key and separately reviewed accounting database setup, then deploys only under separate approval. A JNR test-company admin opens Integrations → Sage → Connect using a controlled test business. **See:** Sage returns to the right Tolra company, with the correct business name; secret remains hidden.
6. [ ] Check a trial invoice balance; disconnect/reconnect under the rehearsal. **See:** evidence only, no Tolra payment recorded and no invoice exported. Second company's connection/figures unchanged. If Sage offers no suitable free test business, mark BLOCKED rather than using real customer records by default.

## QuickBooks Online: sandbox first

1. [ ] Open https://developer.intuit.com/ with the approved business-owned login. Open the app dashboard, create a **QuickBooks Online / Accounting API** web app and use **Development / Sandbox** keys. **See:** a sandbox company and development keys; no live subscription purchase. Current portal labels may differ.
2. [ ] Enter Tolra and https://tolra.co.uk. In the development app's redirect settings register **https://tolra.co.uk/api/accounting/quickbooks/callback** exactly. **See:** the saved development callback, not the Xero path or a marketing redirect.
3. [ ] Copy the **development** client ID and secret value to the secret manager. Code sets `QUICKBOOKS_CLIENT_ID` ← development ID; `QUICKBOOKS_CLIENT_SECRET` ← development secret; `QUICKBOOKS_REDIRECT_URI` ← callback above; explicitly `QUICKBOOKS_ENVIRONMENT=sandbox` in the agreed Vercel test environment. **See:** sandbox settings paired with development keys. The adapter uses sandbox unless the environment value is exactly `production`; never mix development keys with production mode.
4. [ ] Review consent: **com.intuit.quickbooks.accounting** is the Accounting scope, broader than a promise of provider-enforced read-only access. **See:** actual provider permission text and John/Rhys approval. Leave it off if not acceptable.
5. [ ] After the separate schema/encryption/deployment checks, the authorised test admin opens Integrations → QuickBooks → Connect and chooses the intended sandbox business. **See:** return to the correct Tolra company with the correct company name. The returned realm/business ID is handled by the app, not pasted into the public form.
6. [ ] Check a trial invoice, disconnect and compare another company's state. **See:** balance evidence only, no automatic paid mark or invoice export; no mixed tokens/data. Record controlled errors and actual receipts of callbacks.

## Before live use

The current Sage/QuickBooks adapters **check balances only**; this paperwork adds no export, sync or automatic payment feature. Production credentials, provider review/verification, terms, cost and live-company consent are separate decisions. QuickBooks production would require the approved production keys/callback registration and `QUICKBOOKS_ENVIRONMENT=production`; **do not switch it as part of the free sandbox exercise**.

For both providers keep `INTEGRATIONS_ENCRYPTION_KEY` stable and private. Saved Xero/Microsoft platform credentials are not storage for Sage/QuickBooks secrets. Never paste secrets, auth codes or tokens into GitHub/screenshots. Stop on a callback mismatch, unsupported product, consent concern or missing free-test access.

Sage actual terms/test account checked by/date: ____. QBO terms/sandbox checked by/date: ____.

Result per provider: Sage [ ] PASS [ ] FAIL [ ] BLOCKED [ ] NOT RUN; QBO [ ] PASS [ ] FAIL [ ] BLOCKED [ ] NOT RUN.

Rhys name/signature/date: ____  John consent reference: ____  Code/checker name/date: ____

Blank master, prepared 4 November 2026. Fill and sign a private copy. An empty box is not approval. Keep phone numbers, customer records, keys and signatures out of the public repository.
