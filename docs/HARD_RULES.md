# Hard Rules for Tolra SaaS Agents

Copy these into every Claude Code / ChatGPT prompt.

1. Touch ONLY listed files.
2. One module only.
3. Extract from large pages (>10k), never grow them.
4. Business logic behind typed interfaces in `lib/` or module files.
5. Pass typecheck + module tests.
6. No migrations or production changes unless explicitly allowed.
7. Short boundary comment on changed files.
8. Stop and ask on ambiguity or cross-module impact.
9. Integrations off-by-default, feature-flagged.
10. Changes must be isolated so a day-of fix in one area cannot break others.

Violations waste time and create messier code. Stop immediately if you cannot comply.
