# Tolra SaaS Step-by-Step to Verification & Production

Goal: Fully functioning multi-tenant SaaS. Agents follow hard rules + modules. No more thrashing on huge pages or unverified candidates.

## Phase 0: Guardrails (this PR)
- Hard rules, modules, roadmap in place.
- Agents must read these before any code.

## Phase 1: Extract & Stabilize Core Modules (do in order, one at a time)
1. **Jobs module**: Extract UI and filters from `jobs/page.tsx` into `components/jobs/`. No logic change. Pass tests.
2. **Invoices module**: Extract totals, linking, status from `invoices/page.tsx`.
3. **Quotes module**: Extract pricing and status.
4. **Auth/Company**: Confirm isolation, freeze interfaces.
5. **Schedule/Time**: Extract from large pages.
6. **Customers/Suppliers**: Confirm CRUD.

After each: typecheck + module tests green. Small PR. Update MODULES.md if boundaries change.

## Phase 2: Integrations (isolated)
- Xero, AI, email, M365, costing: behind flags, off by default.
- Deploy only after Phase 1 core is verified.
- Current work on these is paused until extractions done.

## Phase 3: Verification Gate
- Full typecheck, unit, db, e2e relevant to changed modules.
- No open draft candidates that touch multiple modules.
- Document what is production-ready.

## Phase 4: Production
- Migrations only via explicit release tasks.
- Feature flags for any new capability.
- Day-of changes limited to one module's interface.

## Agent Task Template
```
Task: [exact description]
Module: [one from MODULES.md]
Allowed files: [list]
Do NOT touch: everything else
Requirements: extract if page large; interfaces; typecheck + tests; boundary comment
Stop if: ambiguity or cross-module
```

Follow this. No deviations.
