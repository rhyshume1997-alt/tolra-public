# Costing follow-up (job 18)

Machine-specific labour rates, including zero, are retained in the screen model and used in the pricing operation. Saving locks the editor and uses one snapshot-checked RPC with stable row IDs. Fractional-penny manual rates are refused. Customer-visible labels use row numbers rather than database UUIDs. A company switch reloads the rates and remounts the pricing form.

`supabase/proposals/builder2_costing_settings_atomic.sql` is an **unapplied review proposal**, not a numbered migration. Claude must assign a number after 143, verify RLS, MFA/support refusal, stale snapshots, concurrent sessions, rollback on invalid rates, name changes/swaps and retry behaviour, and apply it through the agreed process. The UI has no multi-request fallback: missing RPC means setup is required. All clients must use the new path before claiming concurrency protection across clients. No SQL was run by builder2.
