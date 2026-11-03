import { expect,it } from "vitest";
import { dayTotals,settingsFromRow,type AttendanceEvent } from "@/lib/time-sheet";
import { paidDay,paidWeek,paidHoursExplanation } from "@/lib/working-hours";

it("two companies keep opposite break rules side by side and planned hours equal each company's timesheet",()=>{
  const rows={
    A:Object.freeze({organization_id:"company-a",breaks_paid:true,lunch_minutes:30,break_minutes:15,break_min_day_hours:6}),
    B:Object.freeze({organization_id:"company-b",breaks_paid:false,lunch_minutes:30,break_minutes:15,break_min_day_hours:6}),
  };
  const settings={A:Object.freeze(settingsFromRow(rows.A)),B:Object.freeze(settingsFromRow(rows.B))};
  const before=structuredClone(settings);
  const totals={A:new Map<string,number>(),B:new Map<string,number>()};
  const dates=["2026-11-02","2026-11-03","2026-11-04","2026-11-05","2026-11-06"];
  for(const date of dates) {
    // Alternate order, including repeated reads, to catch shared/default state
    // carrying the first or most recently used company's break choice.
    for(const company of ["A","B","B","A"] as const) {
      const user=`${company}-worker`;
      const events:AttendanceEvent[]=[
        {id:`${company}-${date}-in`,user_id:user,action:"in",at:`${date}T08:00:00Z`,received_at:`${date}T08:00:00Z`},
        {id:`${company}-${date}-out`,user_id:user,action:"out",at:`${date}T16:00:00Z`,received_at:`${date}T16:00:00Z`},
      ];
      const planned=paidDay("08:00","16:00",settings[company])!;
      const clocked=dayTotals({date,events,labour:[],settings:settings[company],bankHolidays:new Map(),now:Date.parse("2026-11-07T00:00:00Z")});
      expect(planned.atWork).toBe(480);
      expect(planned.paid).toBe(company==="A"?480:435);
      expect(clocked.paid).toBe(planned.paid);
      totals[company].set(date,clocked.paid);
      expect(paidHoursExplanation(settings[company])).toContain(company==="A"?"Breaks are paid":"Breaks are unpaid");
    }
  }
  const week=dates.map(()=>({start:"08:00",end:"16:00"}));
  expect(paidWeek(week,settings.A).paid).toBe(2400);
  expect(paidWeek(week,settings.B).paid).toBe(2175);
  const actual={A:[...totals.A.values()].reduce((a,b)=>a+b,0),B:[...totals.B.values()].reduce((a,b)=>a+b,0)};
  expect(actual).toEqual({A:2400,B:2175});
  expect(paidWeek(week,settings.A).paid).toBe(actual.A);
  expect(paidWeek(week,settings.B).paid).toBe(actual.B);
  expect(settings).toEqual(before);
  expect(rows.A.breaks_paid).toBe(true);expect(rows.B.breaks_paid).toBe(false);
  expect(settingsFromRow(null).breaksPaid).toBe(false);
});
