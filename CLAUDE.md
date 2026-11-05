<!-- BEGIN:claude-session-context -->
# Claude Code: context that survives compaction

- The shared rules are in `AGENTS.md` (imported below). They apply to you.
- `.claude/settings.json` runs `.claude/hooks/session-context.mjs` on every `SessionStart` (startup, resume, clear, compact). Its "TOLRA SESSION CONTEXT" block gives the branch, the CURRENT ASSIGNED TASK, other open Claude Code work and the approved decisions. Resume only the assigned task; don't restart planning. The other open work is information only: never start it unless Rhys assigns it to you.
- When you take a task, record it in `.claude/current-task.local.md` (untracked): Task ID, owner, branch, PR, acceptance criteria, next step. Keep the next step current; delete the file when the task is finished.
<!-- END:claude-session-context -->

@AGENTS.md

# Notes for AI coding assistants

- This is NOT the Next.js you know: read `node_modules/next/dist/docs/` before writing code.
- The operating protocol, progress log and handover documents live in the private repository and are not part of this tree.
- Hard rule: Do not make extra work or go looking for problems; only do what is asked.
