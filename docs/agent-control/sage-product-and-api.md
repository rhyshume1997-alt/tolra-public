# Sage: exact product and API

**Main 68f89ca:** only general CSV/Excel and year-end file exports were found, in lib/export-records.ts and lib/year-end-export.tsx. No Sage API adapter is on main; do not describe a generic CSV as a verified Sage-specific import format.

**Open #221, public head 53030fd4224c6b2451f2af386fdb9d692b0ee8fc:** lib/accounting/cloud-adapters.ts targets **Sage Business Cloud Accounting (Sage Accounting), Accounting API v3.1**. It does not target Sage 50 desktop/50cloud Accounts or Sage 200.

| Exact code | What it does |
| --- | --- |
| cloud-adapters.ts line 12 | OAuth authorize https://www.sageone.com/oauth2/auth/central; token https://oauth.accounting.sage.com/token; full_access scope |
| Same file lines 15–27 | SAGE_CLIENT_ID, SAGE_CLIENT_SECRET, SAGE_REDIRECT_URI; callback /api/accounting/sage/callback; absent config refuses |
| Same file lines 62–67 | GET https://api.accounting.sage.com/v3.1/businesses; requires unambiguous business |
| Same file lines 90–112 | GET /v3.1/sales_invoices, X-Business header, exact invoice-number match, GBP total/outstanding pence, reviewOnly:true |
| #221 app/api/accounting/[provider]/[action]/route.ts; lib/accounting/connections.ts | Shared company connection/review workflow; not an outbound Sage posting connector |

Main Sage API connection: **NOT STARTED**. #221 cloud read-only lookup: **BUILT, DISABLED / CONFIGURATION REQUIRED**, pending review/merge/configuration. Outbound Sage invoice/credit/payment posting: **NOT STARTED** in the inspected adapter. OAuth full_access is broader than the lookup code's GET behaviour; do not call the token itself read-only.

Source read only: 0 tests run, no live Sage calls, keys, records or SQL. No claim about real Sage tenant compatibility, CSV import acceptance or deployment. No installation/redesign or John message.
