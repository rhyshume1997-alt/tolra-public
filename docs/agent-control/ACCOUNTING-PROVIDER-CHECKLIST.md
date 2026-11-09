# Adding one accounting provider

CODED / TESTED refers to source and named mocked checks, not a live account. Only Xero has a transfer adapter on main. QuickBooks and FreeAgent are checklist examples, not built connectors. No keys/live calls/migration/activation in this change.

Existing interface: lib/integrations/types.ts AccountingProvider. Xero implements it in lib/integrations/xero/client.ts. The shared engine accepts that interface through injected dependencies. Shared contact matching is contacts.ts; common mapping gates and penny reconciliation now live in mapping-rules.ts (the Xero mapper re-exports old names for compatibility). Xero-specific payloads remain xero/mapper.ts. Server/token/DB boundaries remain existing code, not duplicated.

Before adding QuickBooks or FreeAgent:

- Confirm exact product/API, approved scopes, tenant identity, token storage, refresh/revoke rules and provider-specific void/credit/payment policy. Xero supplies its void policy through the interface; provide the new adapter's policy explicitly, never assume equivalent accounting semantics. Existing Xero UI/error wording is not evidence another product is supported.
- Implement the existing AccountingProvider interface; keep HTTP/payload translation in its adapter. No copied send engine or second contact/mapping/queue implementation.
- Reuse decideContact: exact unique active match, no guesses for duplicates/archived/case collisions. Keep company/provider identity on every mapping/contact/record.
- Map sales/credit accounts and every VAT key before transfer. Reconcile returned invoice/credit net/VAT/gross to the penny; missing/ambiguous response is unknown, never zero or first-match success (#396).
- Reuse stable per-send/contact idempotency keys and durable queue/status claims. Hold unknown outcomes, read back before retry, bound retries, respect rate limits and keep manual check evidence. Never record a payment because of a transfer or claim.
- Reuse accountant CSV/Excel exports: xero/batch SUMMARY_COLUMNS/summaryRows and summary API already support both formats with formula guards and company/range scoping. Keep original year-end summary/payments/credits and audit history. Move shared presentation pieces only when a second real adapter needs them; do not invent a connector to justify an abstraction.
- Require default-OFF launch control for existing and new connections (#403), admin/MFA/support/company guards, explicit approval, safe credential messages and sanitized audit/status errors. No provider registration means no connection or transfer button.
- Test with mocked HTTP only: contacts, VAT mappings, invoice/credit, 429/auth/timeouts, ambiguous read-back, lost reply, same-key replay, company isolation, held queue/retry and audit status. Verify database changes on a self-created identified disposable DB. Keep failure logs.
- Independent review and exact-SHA required integration precede READY FOR KEYS. CONNECTED needs actual authorised connection evidence; MERGED, DEPLOYED and LIVE VERIFIED each need their own evidence. No such status is inferred here. DONE must name which stage is done.

Existing evidence reused: integrations-engine, integrations-crypto-oauth, xero-mapper, xero-mappings-send-log, xero-batch-select/chunk/routes/deps tests. #396/#403 remain companion fixes not merged into this main-based PR. No duplicate transfer/export workflow was added because the requested pieces already exist.

This change: CODED and TESTED — 120 focused mocked tests passed, 0 failed/skipped; TypeScript and targeted lint passed. Shared engine no longer imports Xero mapping/policy modules; the Xero adapter supplies void policy, and old mapper export names delegate to the one shared implementation. Existing accountant CSV and XLSX routes/buttons are retained. READY FOR KEYS: not claimed; CONNECTED/MERGED/DEPLOYED/LIVE VERIFIED: UNPROVEN. DONE here means the code/checklist change only, not release acceptance.
