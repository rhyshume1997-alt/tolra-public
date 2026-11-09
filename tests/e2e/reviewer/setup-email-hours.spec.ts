import { expect, test } from "@playwright/test";
import { addDays, localDateOf, weekStartOf } from "@/lib/time-sheet";
import { adminClient, createSoloTenant, signedInClient, withDb } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { signIn, world } from "../helpers";
test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);

test("V-BREAKS: paid and unpaid companies show separate planned hours matching their real timesheets", async ({ page, browser, baseURL }) => {
  const a = await createSoloTenant(world().runId, "v-paid"); const b = await createSoloTenant(world().runId, "v-unpaid");
  const week = addDays(weekStartOf(localDateOf(new Date())), -7);
  for (const [tenant, paid] of [[a, true], [b, false]] as const) await withDb(async db => {
    await db.query("INSERT INTO public.time_settings(organization_id,breaks_paid,lunch_minutes,break_minutes,break_min_day_hours) VALUES($1,$2,30,15,6)", [tenant.id, paid]);
    for (let index = 0; index < 5; index++) {
      const date = addDays(week, index);
      await db.query("INSERT INTO public.attendance_events(organization_id,user_id,client_op_id,action,at,source,recorded_by) VALUES($1,$2,gen_random_uuid(),'in',$3,'clock',$2),($1,$2,gen_random_uuid(),'out',$4,'clock',$2)", [tenant.id, tenant.admin.id, `${date}T08:00:00Z`, `${date}T16:00:00Z`]);
    }
  });
  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage(); await signIn(page, a.admin); await signIn(other, b.admin);
    for (const [tab, tenant, paid, total] of [[page, a, true, "40:00"], [other, b, false, "36:15"]] as const) {
      await tab.goto("/settings"); await expect(tab.getByRole("checkbox", { name: /^Breaks are paid/ })).toBeChecked({ checked: paid });
      await expect(tab.getByTestId("working-hours-week-paid")).toHaveText(total);
      await tab.goto(`/time/week?week=${week}`); await expect(tab.getByTestId(`week-row-${tenant.admin.id}`).getByTestId("week-paid")).toHaveText(total);
      await tab.reload(); await expect(tab.getByTestId(`week-row-${tenant.admin.id}`).getByTestId("week-paid")).toHaveText(total);
    }
  } finally { await context.close(); }
});
test("V-SETUP-ROLES: office, workshop and viewer cannot read or change saved admin setup rows", async ({ page }) => {
  const tenant = world().tenants.alpha;
  const service = adminClient();
  expect((await service.from("company_setup_progress").upsert({ organization_id: tenant.id, step: "company", completed: true })).error).toBeNull();
  for (const role of ["office", "workshop", "viewer"] as const) {
    const client = await signedInClient(tenant.users[role]);
    const rows = await client.from("company_setup_progress").select("*").eq("organization_id", tenant.id); expect(rows.error).toBeNull(); expect(rows.data).toEqual([]);
    expect((await client.from("company_setup_progress").upsert({ organization_id: tenant.id, step: "company", completed: false })).error?.code).toBe("42501");
  }
  await signIn(page, tenant.users.admin); await page.goto("/settings");
  const guide = page.getByRole("region", { name: "Company setup", exact: true }); await expect(guide.getByRole("checkbox").first()).toBeChecked();
});
test("V-EMAIL-LEGACY: old templates reopen unchanged and read-only users cannot save", async ({ page }) => {
  const tenant = world().tenants.beta;
  const original = { subject: "Saved subject", body: "Hello {{customer_name}},\n\nSaved  spaces.\n\nUnknown {{old_marker}}\n\nRegards,\nExample Company" };
  const admin = await signedInClient(tenant.users.admin);
  expect((await admin.from("email_templates").upsert({ organization_id: tenant.id, key: "invoice_reminder", ...original })).error).toBeNull();
  await signIn(page, tenant.users.admin); await page.goto("/settings");
  const card = page.getByTestId("email-template-invoice_reminder"); await expect(card).toContainText("old_marker");
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.reload();
  const saved = await admin.from("email_templates").select("subject,body").eq("organization_id", tenant.id).eq("key", "invoice_reminder").single(); expect(saved.error).toBeNull(); expect(saved.data).toEqual(original);
  for (const role of ["viewer", "workshop"] as const) {
    const client = await signedInClient(tenant.users[role]);
    expect((await client.from("email_templates").upsert({ organization_id: tenant.id, key: "invoice_reminder", subject: "Forbidden", body: "Forbidden" })).error?.code).toBe("42501");
  }
  const unchanged = await admin.from("email_templates").select("subject,body").eq("organization_id", tenant.id).eq("key", "invoice_reminder").single(); expect(unchanged.error).toBeNull(); expect(unchanged.data).toEqual(original);
});
