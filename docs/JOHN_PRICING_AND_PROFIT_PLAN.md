# Pricing, running costs and profit: plan (from John, scoped with Rhys, 26 Nov 2026)

Status: PLAN ONLY. Nothing is built. Starts after the data wipe, #644 and #645 have landed. Every stage is its own PR, behind a company switch that is OFF by default, with a migration proposal (rollback, rehearsed on scratch first, no production SQL without the owner's yes).

## Ground rules (owner)
- **No figure from John's notes is a default.** Rates, headcount, hours, weeks, overheads, markups and targets are entered by John in Tolra himself. Tests may use made-up numbers, labelled as examples. Until a figure is entered, the views say "Enter your rates in Settings" and show no number.
- **Profit = what is left after wages, running costs, suppliers and materials.** John's own pay comes from dividends, so it is not a cost; the views say "profit before dividends".
- **Only John sees profit figures** (a per-user "can see profit" switch, off by default).
- Everything links: quotes, jobs, purchase orders, invoices.

## What John told us (answers, 26 Nov)
- Markup on top changes by customer (anywhere from 15 to 50 percent). Hours are not priced differently; the customer's markup is what changes.
- Anything he buys in gets one percentage added, in case of a mistake.
- Floor: 3 men, 38 hours a week, 48 weeks a year. John is office, not shop floor, and is not counted in shop capacity.
- He does not know his break-even hourly rate; that is what he is trying to work out.
- Running costs belong in the app (Settings), and the app should tell him whether a price covers them.
- Targets: yearly roughly 770 to 800 thousand, this year around 500 thousand, profit around 30 to 40 percent (his rough numbers; he enters his own in Tolra).
- He notices overruns himself; he does not bill extra work now. He raises another quote and sends another PO.
- For a repeat job he wants last time's hours, cost and what it really made.
- Overview: everything matters (big jobs taken, profit per job, monthly profit percent, capacity, money owed).

## Stages
### A. Settings (migration proposal)
- [ ] Crew (men on the floor), hours per week per man, working weeks per year, hourly cost per man (all entered by John, empty by default)
- [ ] Running costs section: list of regular business costs (name, amount, monthly or yearly), monthly total
- [ ] Bought-in percentage (one company-wide setting; a quote line can override it)
- [ ] Markup per customer (15 to 50 percent range, set on each customer; quotes start from it)
- [ ] Targets: yearly target and monthly profit percent target
- [ ] Break-even helper: the hourly rate he must charge to cover wages and running costs, and the rate for a profit percent he picks (a calculation, not a stored assumption)
- [ ] "Can see profit" per-user switch (off by default), John only
- [ ] Migration proposal + rollback + scratch rehearsal; switch off by default

### B. Cost and profit links
- [ ] Quote lines show cost against price (labour hours x hourly cost, bought-in items plus the bought-in percentage)
- [ ] Quote warning (never blocks): does not cover costs (break-even) / below the target profit percent (two separate lines)
- [ ] Per-job profit: invoiced value minus wages (actual hours from the men's time sessions), PO costs (POs already link to a job or quote) and overhead share
- [ ] Blank, not guessed, while any needed rate or hours is missing

### C. Overview (John only)
- [ ] Monthly profit percent against target
- [ ] Profit per job after wages and overheads
- [ ] Capacity: men x hours against booked work
- [ ] Big jobs being taken, and a "which jobs to chase" list against the yearly target
- [ ] Money owed (existing Numbers data)

### D. Overruns, extra work and repeat jobs
- [ ] Overrun flag on the job board (planned against actual hours; reuse the existing planned-vs-actual)
- [ ] "Raise an extra-work quote" action on a job: creates a draft quote linked to the original job, prefilled with the extra hours, never sent automatically (this matches what John does today: another quote and another PO)
- [ ] Repeat job panel in the quote builder: last time's hours, cost and what it really made

## Already in Tolra (reuse, do not rebuild)
Costing engine (labour, programming, overhead, margin, machine rates), "Price this part" in the quote builder, planned-vs-actual panel and machine-hours variance report (flag-gated), WIP ageing, revenue reports (no costs), Numbers page, schedule bookings (planned hours), operator sessions (actual hours), POs linked to jobs and quotes.

## Open questions
- [ ] Should quotes warn against break-even only, or also against the target profit percent? (Plan: both, as two lines.)
- [ ] Is one bought-in percentage enough, or should it vary by supplier or item? (John says one percentage.)
- [ ] Should "can see profit" be visible to office or Rhys if John allows it? (Plan: John only by default.)
- [ ] Which month does the "year" start in, for the yearly target?

## Timing
About 1 to 1.5 days each for A, B, C and D plus CI (integration about 90 minutes). Earliest start is after the wipe yes, #644 and #645. Not for Monday.
