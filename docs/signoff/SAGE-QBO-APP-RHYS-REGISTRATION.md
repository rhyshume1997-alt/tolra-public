# Rhys: register Tolra with Sage and QuickBooks

**The domain comes first.** Complete C10: https://tolra.co.uk must work securely on the approved Vercel/Supabase setup. Then register the exact return addresses below. Buying the name alone is not enough; recheck these addresses if the domain changes.

Use free developer/test access where offered. Do not buy a subscription/upgrade here. A developer account is not approval or a promise of free live accounting. Rhys checks current terms, prices, region, limits and test-company availability. If free testing is blocked, STOP and record why; do not substitute real customer accounts. Portals/prices were not checked live by this writer.

A **return address** (callback/redirect) is where the service sends you after sign-in. A **client ID** identifies Tolra's app; a **client secret** is its private password. Keep secrets in the approved password/secret store, never this form or public screenshots.

## Sage Accounting cloud

1. [ ] Open https://developer.sage.com/ with the approved business login. Choose **Accounting** and register a web app that keeps its secret on the server (often labelled confidential app). Choose the correct region/product. **See:** Sage Accounting cloud registration, not desktop Sage 50.
2. [ ] Name it Tolra; website https://tolra.co.uk. Register `https://tolra.co.uk/api/accounting/sage/callback` exactly. **See:** saved address, no extra slash/query or Preview hostname.
3. [ ] Copy client ID and secret **value** into the approved secret store. Give the technical person the copy list below. **See:** the correct private server settings; there is no Sage secret box in Tolra's current Xero/Microsoft app-registration screen.
4. [ ] Read Sage's actual permission request with John. The code asks for `full_access`, which can allow more than Tolra's balance-check screen uses. **See:** the real wording understood and agreed. If unacceptable, leave Sage off and obtain a reviewed permission decision; do not call the Sage grant read-only.
5. [ ] Technical person checks the existing encryption/database setup and separately approved deployment. A test-company admin then opens **Integrations → Sage → Connect** with the safe test business. **See:** return to the right Tolra shop and business name, secret hidden.
6. [ ] Check a trial invoice balance, disconnect/reconnect and compare the other shop. **See:** balance evidence only, no payment recorded or invoice exported; other shop unchanged. No suitable free test business means BLOCKED.

## QuickBooks Online: use the practice company first

1. [ ] Open https://developer.intuit.com/ with the approved business login. Create a **QuickBooks Online / Accounting API** web app. Choose **Development / Sandbox** keys: sandbox means a practice accounting company. **See:** practice company and development keys, no live subscription purchase.
2. [ ] Enter Tolra and https://tolra.co.uk. In development redirect settings, register `https://tolra.co.uk/api/accounting/quickbooks/callback` exactly. **See:** the development address above, not the Xero address.
3. [ ] Save the **development** ID/secret privately. Technical person uses the copy list below, explicitly choosing sandbox. **See:** practice keys paired with practice mode, not live mode.
4. [ ] Read the actual permission request with John. The code asks for `com.intuit.quickbooks.accounting`; that accounting permission is broader than a read-only promise. **See:** informed agreement, or leave it off.
5. [ ] After technical checks and the separate deployment approval, a test-company admin chooses **Integrations → QuickBooks → Connect** and the intended practice company. **See:** correct Tolra shop/business name. The app handles the returned business/realm ID; do not paste it publicly.
6. [ ] Check a trial invoice, disconnect and compare the other shop. **See:** balance evidence only, no automatic paid mark or invoice export, no mixed accounts. Save actual return/error results privately.

## Copy list for the technical person

Use the agreed Vercel environment, server-only settings:

| Setting | Exact value to copy |
| --- | --- |
| `SAGE_CLIENT_ID` | Sage app's client ID |
| `SAGE_CLIENT_SECRET` | Sage secret value |
| `SAGE_REDIRECT_URI` | `https://tolra.co.uk/api/accounting/sage/callback` |
| `QUICKBOOKS_CLIENT_ID` | QuickBooks **development** client ID |
| `QUICKBOOKS_CLIENT_SECRET` | QuickBooks **development** secret value |
| `QUICKBOOKS_REDIRECT_URI` | `https://tolra.co.uk/api/accounting/quickbooks/callback` |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` for this practice |

Keep `INTEGRATIONS_ENCRYPTION_KEY` unchanged/private. Xero/Microsoft's saved credentials are not storage for Sage/QuickBooks secrets. Do not change settings to force a failed test through.

Current Sage/QuickBooks connections **check balances only**; they do not export invoices, synchronise everything or mark invoices paid. Live credentials, provider checks/approval, cost and company consent remain separate decisions. QuickBooks live use would need its approved **production** keys/callback and `QUICKBOOKS_ENVIRONMENT=production`; do not make that change in this free-test exercise. The adapter otherwise uses sandbox; never pair practice keys with production mode.

Sage terms/test business checked by/date: ____. QuickBooks terms/practice company checked by/date: ____.

Sage: [ ] PASS [ ] FAIL [ ] BLOCKED [ ] NOT RUN. QuickBooks: [ ] PASS [ ] FAIL [ ] BLOCKED [ ] NOT RUN.

Rhys signature/date: ____  John's permission-agreement reference: ____

Technical person/checker name/date: ____

Blank master, prepared 4 November 2026. Complete/sign a private copy. Empty boxes are not approval; this writing job performed none of the actions above.
