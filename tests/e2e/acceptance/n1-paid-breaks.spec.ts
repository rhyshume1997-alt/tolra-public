import {expect,test} from '@playwright/test';
import {addDays,localDateOf,weekStartOf} from '@/lib/time-sheet';
import {createSoloTenant,withDb} from '../../support/fixtures';
import {signIn,world} from '../helpers';
import {requireReviewerDatabase} from './require-database';
requireReviewerDatabase();
test("CJ-N1: paid and unpaid companies show separate planned hours matching their real timesheets", async ({ page, browser, baseURL }) => {
  const a = await createSoloTenant(world().runId, "v-paid"); const b = await createSoloTenant(world().runId, "v-unpaid");
  const week = addDays(weekStartOf(localDateOf(new Date())), -7);
  for (const [tenant, paid] of [[a, true], [b, false]] as const) await withDb(async db => {
    await db.query("INSERT INTO public.time_settings(organization_id,breaks_paid,lunch_minutes,break_minutes,break_min_day_hours) VALUES($1,$2,30,15,6) ON CONFLICT(organization_id) DO UPDATE SET breaks_paid=excluded.breaks_paid,lunch_minutes=30,break_minutes=15,break_min_day_hours=6", [tenant.id, paid]);
    await db.query("UPDATE public.organization_settings SET company_profile=company_profile || $2::jsonb WHERE organization_id=$1", [tenant.id,JSON.stringify({workStart:'08:00',workEnd:'16:00',workDays:[1,2,3,4,5]})]);
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
