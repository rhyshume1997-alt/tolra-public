# Outsourced jobs (jobs another company does instead of us): plan (Rhys, 26 Nov 2026)

Status: PLAN ONLY. Nothing built. One PR, behind a company switch that is OFF by default, with a migration proposal (rollback, rehearsed on scratch first, no production SQL without the owner's yes). Queue it after #644 and #645.

## What Rhys wants
Some jobs are not done in-house: they are passed to another company to do instead. We need a button to mark a job as sent out and another to mark it back in, so everyone can see it is external.

## Status labels (owner wording, colours)
| Label | Colour | Meaning |
|---|---|---|
| Outsourced (To be sent) | grey | The job is marked as outsourced but has not gone yet |
| Outsourced (In progress) | amber | Sent out, with the other company ("Send out" pressed) |
| Outsourced (Complete) | green | Back in ("Back in" pressed) |

## Behaviour
- [ ] On the job: "Mark as outsourced" (becomes grey "To be sent"), then "Send out" (amber "In progress"), then "Back in" (green "Complete"). Each press records who and when (job history).
- [ ] Company picker: a picker of the existing Suppliers that CREATES a new supplier when you type a name that is not there ("Add 'X' as a new supplier"), so the name is saved for next time. Only people who can already create suppliers (admin, office) can add one.
- [ ] Optional due-back date when sending out; the job board chip shows "Outsourced (In progress): [company], due back dd/mm".
- [ ] A job that is outsourced needs no machine: the schedule does not ask for one, and an existing booking is offered for removal when the job is marked outsourced.
- [ ] Attention list: outsourced jobs past their due-back date.
- [ ] Optional link to a purchase order for the outside company (a PO can already link to a job): offer "Back in" when that PO is received (a prompt, never automatic).
- [ ] In-house jobs with no machine get a small "No machine yet" flag on the board (today nothing flags them).
- [ ] After Back in the job carries on as today: finish, inspection, delivery note, draft invoice (the draft invoice is made at Finish; issuing stays manual and refused until released).
- [ ] Job board filter and the job details show the outsourced status; prints unchanged.

## Data (migration proposal, jobs module)
New fields on jobs (company, marked-at, sent-out-at, due-back, back-in-at, plus a link to the supplier row), written only through guarded functions that reuse the job history table (job_flow_events needs its kind check widened for sent_out and back_in). Append-only history, audited, per-company, no cross-company reads.

## Decisions (all answered)
- [x] Part delivery: ANSWERED (Rhys, 26 Nov 13:08): the draft invoice stays at the FULL order, no shrinking.
- [x] Outsourced (In progress): ANSWERED (Rhys, 26 Nov 13:08): its OWN label, not the normal In progress filter stage.

## Evidence behind this
Scratch flow check (26 Nov): a job with no machine can be finished and followed by inspection, delivery note and draft invoice; a linked purchase order feeds cost only and never changes the job; there is no outsourced marker, no "out" or "back in" date, and nothing flags a job with no machine. Report: FLOW-CHECK-REPORT.md (scratchpad copy).
