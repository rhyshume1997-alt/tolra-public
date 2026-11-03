# Shared accounting connections: operator setup and outstanding checks

Xero, Sage Business Cloud Accounting and QuickBooks Online use `ConnectionAdapter` in `lib/accounting/types.ts`. This is the connection/read-only balance contract; Xero's reviewed outbound send engine and its mapping gate stay separate. Existing Xero API endpoints remain available. Its Integrations Connect/Disconnect controls now use the shared route.

No app registration, subscription, deployment or SQL has been performed by this change. Register developer apps using the providers' free developer registration. Do not purchase a connector, add-on or API plan. QuickBooks defaults to its developer sandbox. If a provider requires a paid API tier or production approval, keep that adapter off and record the condition rather than enabling billing.

Official contracts to verify with each registration (provider terms and scopes can change):

- Sage authentication: https://developer.sage.com/accounting/guides/authenticating/authentication/
- Sage API reference: https://developer.sage.com/accounting/reference/
- QuickBooks OAuth: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization
- Xero OAuth: https://developer.xero.com/documentation/guides/oauth2/overview/

Server-only environment settings (no values belong in this repository or browser):

| Adapter | Required settings | Callback registered exactly |
| --- | --- | --- |
| Sage | `SAGE_CLIENT_ID`, `SAGE_CLIENT_SECRET`, `SAGE_REDIRECT_URI` | `https://your-test-host/api/accounting/sage/callback` |
| QuickBooks | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI` | `https://your-test-host/api/accounting/quickbooks/callback` |
| Xero | Existing stored app credentials or `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` | Existing `/api/integrations/xero/callback` |

All require the existing `INTEGRATIONS_ENCRYPTION_KEY`. Never rotate it without the existing key-rotation procedure. QuickBooks uses sandbox unless `QUICKBOOKS_ENVIRONMENT=production` is deliberately configured after registration approval; do not set that for these tests. Sage requests its documented `full_access` scope, and QBO its accounting scope, but this implementation makes no provider document/payment writes. Tokens are encrypted with company/provider/purpose binding. Refreshes reuse the existing database lease and store rotated tokens before use.

New providers also require proposed database update 144. Until it exists, the server refuses Connect and reports not set up. The SQL changes only the permitted connection providers, the existing OAuth-start whitelist, a readiness marker and the outbound queue filter. Mappings, contacts and sends remain Xero-only. Do not apply it to production as part of reviewing this PR.

Only an own-company admin after the existing MFA checks may connect, disconnect or check. Support is refused. Single-use OAuth states bind company, person and provider. Existing database uniqueness refuses reuse of one external tenant by another Tolra company. A Sage sign-in must expose exactly one business; multiple businesses or another page are refused rather than guessed. QBO realm is verified against its authenticated CompanyInfo endpoint. Invoice checks use the signed-in company's Tolra invoice number and exact provider matches. GBP only; amounts return integer pence. Missing, duplicate, truncated or malformed evidence fails closed. A reduced balance may reflect a credit, not a cash payment: a person must review it. Nothing auto marks a Tolra invoice paid.

Offline checks, from repository root:

```sh
npm ci
npx vitest run tests/unit/accounting-cloud-adapters.test.ts tests/unit/accounting-routes.test.ts tests/unit/accounting-sql-shape.test.ts tests/unit/integrations-engine.test.ts tests/unit/integrations-crypto-oauth.test.ts tests/unit/integrations-connect-safety.test.ts
npm run typecheck
npm run check:migrations
```

Database and live OAuth checks NOT performed here. A database owner must approve and prepare a disposable database, identify it independently and use fake companies before running the following commands. These commands are supplied for that operator; they were not executed:

```sh
# TEST_DATABASE_URL must point to an independently verified disposable database.
# It must already have the main schema through 137. Stop if identity is uncertain.
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/144_accounting_connections.release.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/accounting_connections_144.sql
# After app rollback and disconnecting the test connections, inspect retained test states.
# Rollback refuses rather than deleting any new-provider connection, token or state row.
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/144_accounting_connections.rollback.sql
```

| Step | Operator action | Expected result | Pass / Fail / evidence |
| --- | --- | --- | --- |
| AC-001 | Leave each app unregistered and open Integrations; try its Connect endpoint directly. | Not set up; direct call refused. | ____ |
| AC-002 | In provider sandbox/test business, own-company admin connects each adapter. Repeat as staff/support. | Admin sees All connected with correct business; other roles refused. | ____ |
| AC-003 | Replay callback state; change user/company/provider between start and callback; open two Connects to same external tenant in different companies. | State used once only; wrong context refused; at most one company owns tenant. | ____ |
| AC-004 | Two fake companies reuse an invoice number and local IDs. Check invoices from each session; submit the other company's invoice ID. | Correct connected tenant only; foreign local ID refused; no invoice updates. | ____ |
| AC-005 | Check outstanding, partly settled, zero-balance and credit-adjusted fake invoices; duplicate/missing/non-GBP numbers. | Exact pence evidence or safe refusal; no automatic paid status. | ____ |
| AC-006 | Expire access token; run two checks together; revoke provider consent. | Lease prevents double refresh; rotated token kept; refused sign-in requires reconnect. | ____ |
| AC-007 | Issue fake invoice with Sage/QBO connected; try Xero without mappings. | Sage/QBO enqueue nothing; Xero existing mapping gate still blocks sends. | ____ |
| AC-008 | Disconnect test connection, inspect audit, then review rollback. | Own connection removed/paused only; trace remains; rollback refuses to discard retained rows. | ____ |
