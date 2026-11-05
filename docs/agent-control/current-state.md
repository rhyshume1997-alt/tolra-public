# Current state — 5 November 2026

This is a public reconciliation record, not a master plan or release approval. Main observed: `68f89ca7b801a10587ff9b51d6c820462847b65a`. Source presence means **DONE (coded, merged to main)** only where confirmed; it does not mean deployed or verified in production. Read [decisions](decisions.md) before changing scope.

Authoritative inputs reused: root CLAUDE.md and AGENTS.md (Next.js guidance retained), Rhys's decisions in this session, existing public handovers in #342/#349/#367, cutover corrections #388, validation evidence #385–#392. Main has no tracked docs tree, Progress or public task-board equivalent. CLAUDE.md points to private operating records: those were not accessed. This public record supplements them; it does not replace private evidence or another owner's work.

Tolra main already has quotes, orders, jobs, supplier purchases/allocations, invoices/credits, delivery notes, timers, machine runs/scheduling, RFQ intake, audit history, permissions and accounting exports. It also has Anthropic AI and Xero source integrations. Installed versions, real use and production configuration are not established here.

- AI helper and assistant: **BUILT, DISABLED** for authorised launch policy; code has default-off flags and company switches. **CONFIGURATION REQUIRED**: approval, credentials, company enable and agreed cap. Production OFF is required, not remotely verified.
- Xero: built OAuth, mappings, contacts, send/retry/reconciliation source. **CONFIGURATION REQUIRED**: app, tenant, mappings and approval. Transfers must stay OFF until authorised. Existing-source verification is separate from live proof.
- Actual job profitability: **IN PROGRESS; BUILT, DISABLED** in #378, not main. John must approve rates. Two precision findings remain in #391. Existing profit stays available.
- Release 147 / DEV-001: owned by Claude Code; #359 is occupied. Codex tests #389 pass; #390 has four deliberate red staff-message contracts. Neither is a production acceptance.
- ISO: company draft packs #371/#372 and supplements #392 exist. Company decisions, real records and readiness remain unproven. Documents cannot certify a company.

[Open PR snapshot](open-prs.json) lists all 250 open public PRs at observation, exact heads and URLs. It is an inventory, not an assertion that all belong in one release. #385–#392 are draft evidence work. [Task board](task-board.md) assigns this queue; [release gates](release-gates.md) separates blockers from work that can wait. Targeted feature reconciliation is recorded separately, not inferred from PR titles.
