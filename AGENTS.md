<!-- BEGIN:shared-agent-rules -->
# Shared rules for every coding agent (Claude Code, Codex)

**Start of every assignment:** read `docs/agent-control/task-board.md`, `decisions.md` and `handover.md` (and `current-state.md` if unsure). If `docs/agent-control/` is missing from your checkout, it is still in draft PR #393 (`codex/agent-control-reconcile`): read it there, do not recreate it. `node .claude/hooks/session-context.mjs --text` prints the short version (branch, assigned task, decisions).

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

# Tolra SaaS Hard Rules for AI Agents (Claude Code, ChatGPT, etc.)

You are building a production multi-tenant SaaS. Follow these rules exactly or stop.

## Absolute Rules
1. **Scope only**: Touch ONLY the files listed in the current task. No extra cleanups, no unrelated refactors, no "while I'm here".
2. **One module per task/PR**: Never edit files from two different modules in the same change.
3. **Extract, don't grow**: If a page.tsx is >10k lines of logic, extract a component or hook first. Never add more code to god pages.
4. **Interfaces first**: All new or changed business logic goes behind a typed function/interface in `lib/` or a dedicated module file. Pages and components only call the interface.
5. **Tests required**: Must pass `npm run typecheck` and the relevant unit/db tests for the changed module before finishing. No green = not done.
6. **No production or migration changes** unless the task explicitly lists the exact SQL/file and says "migration allowed".
7. **Document the boundary**: Add a short comment at the top of any new/changed file stating inputs, outputs, and what must not be changed.
8. **Stop on ambiguity**: If the task would affect another module or is unclear, STOP and ask. Do not guess or invent.
9. **Feature flags**: New integrations (Xero, AI, email, etc.) must be off-by-default and isolated behind a flag or company setting.
10. **Future-proof**: Changes to one module must not break others. Prefer composition over inheritance, clear contracts.

## Modules
See `docs/MODULES.md` for allowed files, ownership and interfaces.

## Roadmap
See `docs/SAAS_ROADMAP.md` for the step-by-step path to verification and production.

Hard rule: Do not make extra work or go looking for problems; only do what is asked.
