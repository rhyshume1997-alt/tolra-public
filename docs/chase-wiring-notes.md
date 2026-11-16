# Chase wiring: handover

Branch: `chatgpt2/chase-wiring`, based on `claude/chase-steps`.

- The existing Settings > Email schedules editor now displays builder2's settings card. It validates migration 138's day/tone rules and retains existing step IDs for unchanged offsets. The existing draft-only `/api/chase/run` path is retained.
- Chase drafts in Approvals use builder2's approval card. Edit and skip update only the current company's still-drafted history row. Approve calls `/api/chase/approve` and requires a `sent` result. No provider leaves the draft available for manual sending. Customer pause uses migration 138's existing row-secured table. Ambiguous customer names fail closed.
- Eligible invoices show builder2's payment claim controls only when the claim column exists and the session may change invoices. A manual claim calls `mark_payment_claimed`. Not received calls `resolve_payment_claim`. Confirm opens the existing Record payment form; the claim is cleared only after a payment has been saved. Cancelling the form leaves chasing paused. A failed claim clear never asks the user to record the money again.

## Still missing / needs integration verification

1. Migration 138 has not been applied here. Claude must verify it on the disposable test database and resolve the final migration number. No database has been changed by builder2.
2. Settings writes are separate database requests, as on the base branch. There is no atomic replace-steps RPC. A failed save can leave some steps changed; the card blocks another save and requires a reload. A transaction and concurrent-edit version check need database work by the database owner.
3. The same display name can belong to more than one customer. Approvals refuse to guess which customer to pause. A durable customer ID on invoices would remove that ambiguity.
4. The mail provider and payment flows need real browser/database verification. No test database or mail provider is available in this environment. Unit checks cover the request and persistence adapter, not live delivery.
5. A receipt and claim resolution are separate operations. If the receipt is saved but claim clearing fails, the UI warns and leaves the stored claim for checking. Do not record a second receipt.
6. The new card files are copied from #111–#113 so this branch can be tested independently. Consolidate those PRs when integrating; do not merge duplicate implementations blindly.
