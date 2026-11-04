# Tolra has a problem: what to do

Keep this sheet beside the workshop computer. Tell the office first. If a job is unsafe or its instructions are unclear, stop that job and speak to the workshop supervisor.

## Who to call

| Need | Call in this order | Fill in privately before go-live |
| --- | --- | --- |
| Workshop cannot work | Workshop supervisor, then John / office duty lead | Supervisor name and phone; John's phone; deputy |
| Wrong figures, missing work, wrong company shown | John / office duty lead, then Rhys | Office number; Rhys's number; deputy |
| Tolra down or sign-in broken | Office duty lead tells Rhys; Rhys contacts Claude Code / technical operator | Rhys's contact; operator and cover contact |
| Suspected access to another company's data | Stop using the affected screen; phone Rhys immediately | Restricted incident-record location |

The repository supplies no verified phone numbers or duty rota. John and Rhys must fill in and test this private contact sheet by 6 November. No answer: use the named deputy, keep the affected work on hold and use paper for other safe work. Do not wait silently for a reply.

## Check these first: two minutes

1. Write the time, your name, computer, page and job number. Write what you clicked and the exact message. Keep any screenshot in the private support record; hide customer details.
2. Check the company shown is JNR. If another company's information appears, stop and call Rhys. Do not explore or change it.
3. Ask one colleague whether Tolra works for them. Check whether another normal website opens. This tells the office whether one computer, the workshop connection or Tolra is affected.
4. Read any saved, waiting-to-send or failed message. A click is not proof of a save. **Do not click Send or Save repeatedly.** Keep the page open if work is waiting to send. Do not clear browser data, sign out or reinstall the app.
5. If there is no unfinished form or waiting work, try reopening the page once. If it still fails, call the office and use the paper fallback. Do not reset a password just because the internet is down.

## What to tell JNR staff

“Tolra is having a problem from [time]. Use paper sheet [incident number] for job times, breaks and work done. Keep using only confirmed job instructions. Do not enter the same work twice or send an email again. Give sheets to [office person]. Next update at [time].”

The office gives an update every 30 minutes, even when there is no change. Say which jobs/screens are affected. Tell customers only the practical effect and the agreed next update; do not guess at a recovery time.

## Office / technical operator

Keep one incident number and one person in charge. Record affected people, first/last good times, recent release and actions already tried. Check Vercel deployment health and errors, Supabase status/auth/database access, provider status for email, and the workshop connection. Use the approved exact code revision and private logs; never paste passwords or connection strings into GitHub. A failed save needs record/history checking before any repeat. Unknown email delivery needs mailbox/provider checking before any resend.

Do not roll back, run SQL, reconnect providers, change DNS or restore data as an improvised fix. Rhys decides with the technical operator using the reviewed rollback runbook. If company isolation or figures are in doubt, keep writes stopped.

## Before saying it is fixed

The office checks a known JNR job and hours, verifies no duplicates or missing waiting entries, and checks a safe sample on the affected screen. The operator proves access is limited to the right company. Reconcile paper with saved and queued work before entering it. Record who checked, what they saw and the time. Tell staff when normal entry may resume. Close only after outstanding paper, email and customer follow-ups have an owner.

Related jobs: F5 paper fallback, B5 email proof/fallback, D6 rollback. These are separate draft documents until integrated.

Prepared 4 November 2026 by builder 4. Build and test deadline: Friday 6 November; go-live target: Thursday 12 November. This document does not approve a release. Practical rehearsal and named sign-off remain required.
