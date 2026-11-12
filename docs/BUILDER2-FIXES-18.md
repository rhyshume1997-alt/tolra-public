# Job 18: chase follow-up

- Confirm payment received can reopen the existing form after Cancel. Opening a form no longer finishes a claim.
- Approval submits the exact saved subject/body reviewed by the person. The route requires that snapshot; a stale snapshot is refused before sending. The mailer uses the captured text, so a later draft edit cannot silently replace the words approved.
- Chase settings use one RPC with an expected snapshot, rather than separate delete/update/insert requests. No partial-write fallback. Missing RPC means a visible setup error, never a false successful save.

`supabase/proposals/builder2_chase_settings_atomic.sql` is an **unapplied review proposal**, not a numbered migration. It uses invoker security, company membership, the existing MFA/session checks, advisory and row locks, RLS, and one transaction. Claude must assign the migration number, run database/RLS/concurrent-save tests and apply it through the agreed release process. No SQL was applied by builder2.

Same-name customers still fail closed in the approval wrapper; choosing a durable invoice customer ID requires the database owner's wider schema decision. Live mail/browser/database checks and supported full CI remain required.
