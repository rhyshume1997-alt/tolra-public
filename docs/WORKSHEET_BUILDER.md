<!--
BOUNDARY: documentation only. Inputs: the code on main as read for module K (worksheet builder). Outputs: STEP 1 (how the job worksheet
works today) and the module K rules. It changes no code, flag or company setting. Keep it in step with docs/MODULES.md section 16.
-->

# Job worksheet today (Step 1) and the worksheet builder (module K)

## Step 1: how the job worksheet works today

**Where it is built.** One job = one row in `jobs`. The screen is `components/job-worksheet-form.tsx` (edit), the two sheets are
`components/job-worksheet-print.tsx` (**JNR sheet**) and `components/job-worksheet-basic-print.tsx` (**Basic**), reached by
`components/print-layout-picker.tsx` from `app/(dashboard)/jobs/[id]/print/page.tsx` (one job, A4 portrait) and `app/(dashboard)/jobs/print/page.tsx`
(workshop pack: many jobs in one A4 landscape table, `job-worksheet-pack-print.tsx` or `BasicWorksheetPackPrint`). Data comes from
`lib/job-worksheet.ts` (`loadWorksheet`, `worksheetFromRow`, `worksheetToPatch`).

**The two layouts.**

- **JNR sheet** (the sheet JNR use, never changed): coloured fills; Customer, Customer PO, Date Received/Required, Quote #, Dimension Report #,
  Material Cert #, Heat / Cast #, Job Time Quoted/Taken; Job Description; Drawing #, Quantity, Material required/ordered/supplier, three Machine/Program
  lines, Set Up and Run time; Comments for Improvement; Reasons for Overrun (red when taken exceeds quoted); customer PO and drawings lines; "Part
  Checklist Must Be Completed" with six tick boxes and "Signed off by"; the two red JNR instructions; Internal sign-off; Customer sign-off (printed
  when the job has one, or as an empty box when the company has Customer sign-off on). It **always prints the material cert and heat/cast numbers.**
- **Basic**: plain, no fills; header with the company logo, document name and "JOB SHEET"; Customer, PO, Date received/required, Drawing no., Quantity;
  a **Traceability** block (material cert no. and heat/cast no.) **only on a traceable job**; Description; drawings and customer PO lines; an Operations
  table (8 blank rows) and Notes area; "Checked by" and "Signed off" boxes; Customer sign-off as above. No machines and no part checklist.
- Both print sign-offs exactly as recorded (same wording, `data-signoff` markers, never "signed" for a stale or missing sign-off).

**The Print layout company setting** (`lib/print-layout.ts`, `components/print-layout-settings-card.tsx`). Stored in
`organization_settings.company_profile.printLayout` (`"basic"` or `"jnr"`; admin only, via the 006 trigger; audited). Never chosen: JNR's organisation
(slug `jnr-engineering`) gets the JNR sheet, every other company gets Basic. If the setting cannot be read the **JNR sheet** prints (what everyone
printed before the setting existed). Anyone printing can override per print on the print page (the "Layout" picker; nothing saved). The Company details
save keeps the stored choice (`withStoredPrintLayout`).

**The worksheet fields and where each is stored** (all on `jobs` unless stated):

| Field | Stored |
| --- | --- |
| Material cert no., heat/cast no., dimension report no. | `jobs.material_cert_no`, `heat_cast_no`, `dimension_report_no` (text) |
| Traceable job | `jobs.traceable` (082; default per customer `customers.traceable_default`); a recorded cert or heat number also counts as traceable on Basic |
| Machines and times | `machine_1..3`, `program_1..3`, `setup_time_hr`, `run_time_hr`, `job_time_quoted_hr`, `job_time_taken_hr`; machine names from the machines list |
| Part checklist | `jobs.checklist` jsonb, six keys: `sizes_checked`, `threads_check`, `parts_deburred`, `parts_marked`, `parts_clean`, `parts_counted`; `checked_by` is the "signed off by" name |
| Inspection | records in `job_inspections` (034/081; pass, fail or concession, inspector, date); `jobs.inspected_at/by`; what a job needs before a pass: `jobs.certs_required`, `checklist_required` |
| Sign-off boxes | `job_signoffs` (045): primary, inspector co-signature, hashed over a snapshot of the worksheet fields; the old typed box is `jobs.signed_off_by/at` (read as an old record) |
| Customer sign-off | `job_signoffs` rows with `kind = 'customer'` (072); the company switch is `organization_settings.customer_signoff_enabled` |
| Drawings | `job_files` kind `drawing` with revisions (034), files in the `job-drawings` bucket; the customer's PO is `job_files` kind `customer_po` (067); `jobs.drawing_no` is the number |
| Revision | `jobs.worksheet_version` rises when a watched worksheet field changes (022/034); a sign-off belongs to one revision |

There is **no company-level switch** for internal sign-off, traceability or inspection in this tree (they are per job or per customer); the only company
switch of the three kinds named in the brief is Customer sign-off.

## Module K: the worksheet builder (this change)

Off by default (`worksheet-builder:on` marker in `organization_settings.hidden_nav`, Settings > Worksheet builder, admin). With it off, **nothing
changes**: no custom layout is offered, Basic and JNR sheet print exactly as before and stay the defaults (golden checks:
`tests/unit/worksheet-builder-golden.test.ts` against a snapshot written from main before any module K code, plus the existing
`print-layout*.test.ts` snapshots).

- **Palette** (`lib/worksheet-builder/blocks.ts`): header with logo, job and customer details, description, quantity and dates, operations and notes
  area, material cert and heat/cast, machines and times, part checklist (editable items), drawings list, inspection, customer sign-off, internal
  sign-off, free text box, custom tick box, custom text field. A layout is only ever a list of these; no markup, scripts or formulas.
- **Design** (`components/worksheet-builder/worksheet-builder-card.tsx`): start from Basic, from JNR sheet or from blank; show or hide, reorder, rename
  block and field labels; live preview on sample data with the company logo and brand colour (`brandInk`: only a valid, readable `#rrggbb`).
- **Storage** (no migration): `organization_settings.company_profile.worksheetBuilder` = `{ layouts, activeId }`, validated on every read and write
  (`parseWorksheetBuilder`); Company details keeps it. Up to 10 layouts, 40 blocks each.
- **Choosing**: the layout appears after Basic and JNR sheet in Settings > Print layout and in the print page picker (`resolvePrintChoice`). Anything
  unreadable, or the builder off, resolves to the company's Basic/JNR choice. The workshop pack (a landscape table) prints the layout's Basic or JNR base.
- **Cannot be removed** (`requirements.ts`): internal sign-off, material cert and heat/cast (traceability) and inspection are always required (no company
  switch exists to turn them off); customer sign-off is required while the company's Customer sign-off switch is on. Required blocks can be moved and
  renamed, never hidden or deleted; the save refuses it, and the print repairs any layout saved before a switch was turned on. A recorded customer
  sign-off always prints.
- **Custom fields per job** (`custom-values.ts`, `job-custom-fields.tsx`): custom tick boxes, custom text fields and extra checklist items are stored in
  `jobs.worksheet_custom` (release 170, below), never in `jobs.checklist` or any existing column. Read-only once the job's current revision is signed off.
- **Printed or signed-off worksheets never change**: a layout edit keeps the version it replaces (`history`, up to 10) and a worksheet signed off earlier
  reprints on the layout as it stood at its sign-off (`layoutAsOf`); deleting a layout archives it; custom values lock at sign-off (app and, with release 170,
  database); the sign-off snapshot, `worksheet_version`, inspection and every existing job column are untouched. Limit: a paper copy cannot change, but the
  app does not record which layout an *unsigned* job was last printed on, so a reprint of an unsigned job uses the layout as it is now.

### Release 170 (SQL; phase 170 after 167, nothing applied anywhere)

`supabase/proposals/p170_worksheet_custom.sql` (canonical), `supabase/release/170_worksheet_custom.release.sql`, `.rollback.sql` and
`supabase/verify/worksheet_custom_170.sql`, a numbered phase in `supabase/release-plan.json` with its preflight marker and "170 needs" row, the CI install
step and schema marker, and the post-144 fixture. Adds one column (`jobs.worksheet_custom`, default `{}`), its shape constraint, and a guard that refuses a
browser session changing it once the job's current revision has a primary sign-off. The rollback **refuses while any job holds a custom value** (it never
deletes records). Proved by `tests/db/worksheet-custom-170.test.ts` on the Supabase stack in CI, and locally on plain PostgreSQL 16 by
`tests/postgres/worksheet-custom-170.proof.sql`. Applying it to any real database needs Rhys's separate yes on the exact file, after a fresh backup. The
builder itself stays off by default; until the release is applied the app works and custom fields say they can't be saved yet.
