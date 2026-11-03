# Timesheet checks without a database

From the repository root, after `npm ci`, run `npm run test:timesheet-schedule`.
No Supabase URL, database, account, mail credentials or Docker is needed. The
suite runs real scheduling/form functions for chosen days, time validation,
`08:00:99`, spring and autumn clock changes, and the off-by-default setting.
Existing schedule/form tests remain included; none are replaced or skipped.

These checks really need the isolated database and are not claimed by this run:

- Applying/verifying migration 142 and its weekday constraints and permissions.
- Saving the setting through RLS and proving company/role isolation.
- Database claims, row locks and idempotency under genuinely concurrent sessions.
- Loading real time rows and reserving/recording the timesheet send ledger.
- Browser persistence and cron-to-provider delivery against the disposable stack.

The pure autumn test proves that both clock-hour copies have the same occurrence
key. Only a database concurrency test can prove that two workers reserve it once.
No database operation is part of the offline command.
