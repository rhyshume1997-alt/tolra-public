# Enforced Xero launch hold — default OFF

Companion to #396. This branch starts from main 68f89ca; #396's read-back corrections must also be reviewed/integrated before any activation. This PR does not merge, enable or configure a real company.

Migration **149** adds integration_connections.transfers_enabled NOT NULL DEFAULT false. All existing connections, including connected companies, acquire false. New connections start false; disconnect/reconnect or tenant/status change resets false. Main ends at 137; pending release147 and profitability148 are unchanged. 149 is a proposed next number, to check during Code's final release integration.

An admin uses Admin > Integrations > Xero transfers to explicitly turn this company's transfers on. The server rejects non-admin, support and cross-origin changes; the SQL setter infers company from the session and preserves existing MFA/support guards and audit. Connecting alone never enables transfers. A read error or missing migration refuses the server send path.

Enforcement:
- Server sendQueued returns launch_hold before token read/refresh or engine work. The sweep selects enabled connections only. Provider operations recheck the setting before contact creation, invoice/credit/void writes and retry read-back.
- SQL claim refuses held companies. SQL queue trigger suppresses new transfer rows while held without breaking invoice issue, and rejects requeue/claim updates. Retry RPC refuses held companies. Server batch enqueue/retry also refuses before writes.
- Old queue rows remain for review; enabling can release previously queued work. Documents issued while OFF are not automatically backfilled; an admin must preview/select any historical batch after approval. Never infer a complete backlog from the queue.

A hold cannot recall an HTTP request already in flight. A request authorised immediately before an admin changes the hold can still finish; stop senders and wait for in-flight work when a strict external write freeze is required. Rechecks reduce that window but do not claim a distributed transaction with Xero. OAuth, mapping/test reads and disconnect remain separate admin setup actions, not invoice/credit transfers.

Verification: 221 existing/new mocked unit tests passed, zero failed/skipped; five real database tests passed on fresh nonce-labelled, pinned-image, no-network/no-port databases created by this harness. Identity is checked before every SQL write. Six catalogue checks pass; existing/new OFF, queue/retry blocking, admin/company boundaries, re-hold, reconnect and rollback covered. Release-wrapper tests: 186 passed. TypeScript and targeted lint pass. Counts are separate suites; do not add the initial 60-test subset again. Logs/hashes/SQL/time/exit/container receipts are in tests/reviews/xero-launch/evidence. Minimal synthetic Auth/Storage bootstrap is not a full Supabase/HTTP/browser service.

Apply only after separate operator approval: use supabase/release/149_xero_launch_hold.release.sql, then supabase/verify/xero_launch_hold_149.sql; additionally inspect that every company remains OFF before launch. Never apply to production from this PR. Rollback SQL is supplied for an inactive disposable/recovery stack only: removing the hold restores old send behaviour. Prefer leaving the hold installed. Freeze/stop app and cron senders before any separately authorised rollback; never roll back automatically.

#396 old CI was a missing-ready gate, not an environment limit (exact log in #400). Local checks passed, so ready was added to start full CI run 41993566379; result is recorded separately when observed. This does not make #396 safe to merge or accept this companion's integration. Final combined-SHA full integration/browser checks, production configuration and reviewer conditions remain UNPROVEN.
