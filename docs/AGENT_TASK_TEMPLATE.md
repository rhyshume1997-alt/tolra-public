# Agent Task Template

Use this for every Claude Code / ChatGPT task.

```
Task: 
Module: 
Allowed files: 
- 
Do NOT touch: all other files

Steps:
1. Read docs/HARD_RULES.md and docs/MODULES.md
2. Extract logic if page >10k
3. Put business logic behind typed interface
4. Add boundary comment
5. Run typecheck + relevant tests
6. Stop if anything outside scope

Done only when tests pass and no cross-module changes.
```
