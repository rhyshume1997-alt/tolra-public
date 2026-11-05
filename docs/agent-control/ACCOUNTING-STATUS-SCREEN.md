# Admin accounting status

CODED / TESTED in the existing Admin > Integrations page. Read-only status API uses the signed-in admin's company, existing integration_overview and scoped send-log rows; support/non-admin reads refuse. It never calls a provider or returns credentials.

Xero shows availability, missing configuration, connection/reconnect state, mapping outstanding, enforced launch setting and the latest recorded transfer outcome. Ready requires configured + connected + mapped + no contact problems + explicit enabled=true from149. Missing149/read errors are Unknown, never Ready. Last failed/uncertain transfer remains separate from setup readiness. Sage explicitly shows file export only, not a fake connection. QuickBooks/FreeAgent are not registered because no main adapter exists.

Companions: #403 supplies the enforced OFF control/migration149; #409 labels and links the existing Sage file exporter; #408 preserves the shared transfer boundary. Integrate/review those separately. No migration/provider implementation is introduced by this status screen.

6 mocked status/route tests passed, 0 failed/skipped; TypeScript and targeted lint pass. CONNECTED is only a displayed recorded state, not live verification. READY FOR KEYS, MERGED, DEPLOYED, LIVE VERIFIED remain UNPROVEN for delivery. DONE means this code/test stage only. No live calls, SQL, real/private data, other-agent/#359/go-live edits or John messages.
