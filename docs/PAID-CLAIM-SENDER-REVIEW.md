# Sender review fix

Own branch off chatgpt/paid-claim-adapter, targeting that branch. The adapter parses one conservative mailbox, uses the address inside angle brackets rather than display text, compares exact mailbox/domain ignoring case, and keeps plus tags. It rejects missing, malformed, multiple and control-character senders. A named invoice still needs its own customer mailbox; an unreferenced claim must have one unambiguous invoice. Suggestions remain for human review and do not mark payments.

55 focused cases reported passing (18 existing plus 37 sender cases); TypeScript and targeted lint passed. Local Vitest still requires timeout cleanup after reporting. The detector copy in this parent still needs the job 28 reconciliation with #137; this PR deliberately fixes the sender layer first. Email authentication headers are not present in the input: a valid-looking sender is not proof of authenticity.
