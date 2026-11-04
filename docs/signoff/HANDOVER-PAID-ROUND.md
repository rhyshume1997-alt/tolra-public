# Builder 4 handover: PAID-ROUND

4 November 2026. Explicit Rhys assignment; atomic claims/PAID-ROUND. Read root AGENTS.md, prior builder-4 handover and #271 ownership. One separate draft into main; no implementation owner branch changed.

Rhys explicitly confirmed on 4 November 2026 that PAID-ROUND means paid working time. The sheet records that scope and provides accept-current / request-change / not-ready choices. No new scope or policy is implemented.

Current facts checked in lib/time-sheet.ts (roundMinutes, ROUNDING_NOTE, exact-time paid calculation), lib/time-payroll-export.ts (roundedHours), and the N1 break examples. Display/export rounding is separate from break pay and money/costing rounding. John can accept current behaviour or request a separately reviewed change; neither choice edits records or authorises SQL.

Validation: source/example/diff review; no artificial runtime test added for a blank form. Actual payroll rehearsal and policy approval remain NOT RUN / PENDING; item meaning is confirmed. Build/test deadline 6 November; conditional go-live 12 November 2026. No main merge, production SQL, deployment, wage/account change or fabricated signature.
