<!-- BEGIN:shared-agent-rules -->
# Shared rules for every coding agent (Claude Code, Codex)

**Start of every assignment:** read `docs/agent-control/task-board.md`, `decisions.md` and `handover.md` (and `current-state.md` if unsure). If `docs/agent-control/` is missing from your checkout, it is still in draft PR #393 (`codex/agent-control-reconcile`): read it there, do not recreate it. `node .claude/hooks/session-context.mjs --text` prints the short version (branch, your rows, decisions).

- Implement the assigned task. No master plans, unrelated audits or speculative improvements.
- Every task has one owner, one branch and explicit acceptance criteria on the task board. Work only on your own task and branch.
- Don't reopen completed (DONE) work without new, reproducible evidence. Don't create duplicate features: reuse existing code and records.
- Don't change files owned by another active agent or branch (see the board and open PRs). Don't overwrite another agent's branch.
- Don't merge, deploy, apply production SQL, touch real data or secrets, or change production settings without Rhys's approval.
- Preserve the existing AI, Xero, Sage and accounting work: finish and verify, don't redesign or remove.
- Respect CI, RLS, MFA and financial controls: never weaken, skip or bypass them, and don't add the `ready` label or trigger CI without approval.
- Never claim a test passed unless it ran. Say what could not be tested.
- When a task finishes, update its task-board row (qualified status: coded / merged / deployed / verified in production) and the handover.
<!-- END:shared-agent-rules -->

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
