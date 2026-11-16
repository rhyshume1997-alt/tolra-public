# Costing wiring review fix

Own branch off chatgpt/costing-wiring; PR targets that branch. Builder 1’s branch was not changed.

Uses #145 saveAtomicCosting: one company-scoped RPC contains defaults, additions, changes, removals and expected values. No separate write or partial-save fallback remains in connected-costing. Machine labour overrides survive load/display/save and pricing, including zero; null alone uses the company rate. Costs with fractional pennies fail before any database request. Controls lock while saving.

Includes the unapplied costing proposal for review. See #154 for throwaway SQL tests and rollback; not executed. Claude must package/verify the RPC before production. Combine with #135/#139/#140/#145 carefully: these are alternative stacks, not independent fixes to copy blindly.

22 focused cases reported passing; TypeScript and targeted ESLint passed. Local Vitest still needs timeout cleanup after results. No SQL or live browser tests run.
