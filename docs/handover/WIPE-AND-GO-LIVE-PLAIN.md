# JNR wipe and go live, plain guide

Status: REVIEW DRAFT. This is an explanation, not permission to delete data.

## What the JNR wipe is for

It clears JNR's rehearsal or test business records so that an agreed, checked SliQ export can become the starting point for Tolra. It isn't a reset of the Tolra application or an invitation to delete all customer information.

## What it must never touch

Marpet Fabrications or another company's customers, invoices, jobs, purchase orders, staff, settings, files, audit history or numbering. Shared authentication accounts and the structure of the database must stay intact. Every operation must be restricted to JNR's verified organisation ID, with exceptions explicitly agreed and tested.

## Who runs it

Rhys is the technical decision maker and the only named operator in this plan. John checks the source business records and independently signs off the results. This document doesn't give anyone new permissions.

## Saturday 7 November, planned order

1. Agree the precise JNR organisation ID and source export cutoff, recording the UK date, time and timezone.
2. Export and preserve the old SliQ data and read-only verification evidence. Compare existing open jobs, supplier orders, invoices and customer balances with the signed source. Retain a protected rollback or recovery checkpoint using the approved production procedure.
3. Read and approve the final scoped wipe SQL and its safety preflight. Verify that it refuses to act on Marpet or any company other than the intended JNR organisation. Verify expected object and row counts against the current database.
4. Pause JNR writes for the planned interval. Rhys alone executes the reviewed operation, with its own transaction and postchecks. Never paste unreviewed DELETE or TRUNCATE commands into production.
5. Run the SliQ importer with agreed mappings and source counts. Resolve duplicate invoice numbers and same-name customers by source identifiers, not guesswork.
6. Compare invoices, payments, customer balances, open jobs, supplier orders, WIP and numbering with the independent source exports. Check a sample of records manually.
7. John signs the business reconciliation. Rhys signs the technical checks. If either fails, keep JNR cutover blocked, preserve evidence and use the agreed recovery procedure. Do not proceed merely because an import reported success.

## How to know it worked

PASS requires written confirmation that Marpet before and after counts and representative record hashes have not changed, JNR's intended rehearsal records were handled exactly as specified, import counts and individual links match the source, debtor totals reconcile to the penny, numbering can't collide, and representative job and invoice screens work.

A missing figure, a changed Marpet record or an unexplained debtor difference means NOT VERIFIED. Do not tick PASS.

## What I couldn't confirm from the public repository

I could not locate a definitive reviewed JNR wipe implementation or signed wipe manifest from the accessible public code search. This document therefore doesn't claim which tables are deleted, the exact SQL order, whether files in storage are included, or that the wipe has been proved on a disposable clone. It doesn't invent commands to run.

Before Saturday execution, Rhys needs the exact release script, its JNR-only preflight, verify queries, recovery instructions, approved data retention policy and the independently signed source totals. Any date or order here is a plan, not confirmation that the operation occurred.
