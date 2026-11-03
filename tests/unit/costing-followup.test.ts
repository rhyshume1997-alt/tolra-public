import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mapCostingRates } from "@/components/costing/connected-costing";
import { operationLabourRate } from "@/components/costing/price-this-part";
import { CostingRatesEditor } from "@/components/costing/costing-rates-editor";
import { saveAtomicCosting } from "@/lib/costing/atomic-settings";
import type { CostingRates as Saved } from "@/lib/costing/rates-store";
const saved:Saved={enabled:true,materials:[{id:'material-secret-id',name:'Steel',pricePence:525,priceUnit:'kg',scrapPct:5,updatedAt:null}],machines:[{id:'machine-secret-id',name:'Mill',hourlyRatePence:8500,labourRatePence:1200,updatedAt:null}],defaults:{labourRatePence:3000,programmingRatePence:7500,overheadPct:150,defaultMarginPct:20,updatedAt:null}};
describe("costing follow-up",()=>{
 it("keeps a machine's specific labour rate in pounds",()=>expect(mapCostingRates(saved).machines[0].labourPerHour).toBe(12));
 it("uses an explicit zero override instead of the company rate",()=>expect(operationLabourRate({...mapCostingRates(saved).machines[0],labourPerHour:0},30)).toBe(0));
 it("uses the company rate only when the machine has no override",()=>expect(operationLabourRate({...mapCostingRates(saved).machines[0],labourPerHour:null},30)).toBe(30));
 it("saves one atomic request, with expected values, company and stable IDs",async()=>{
  const db={rpc:vi.fn().mockResolvedValue({error:null})};
  await saveAtomicCosting(db as never,"company",saved,mapCostingRates(saved));
  expect(db.rpc).toHaveBeenCalledTimes(1);
  const [name,args]=db.rpc.mock.calls[0];expect(name).toBe("save_costing_settings_atomic");expect(args.p_org).toBe("company");
  expect(args.p_expected.machines[0].labour_rate_pence).toBe(1200);
  expect(args.p_value.machines[0]).toMatchObject({id:'machine-secret-id',labour_rate_pence:1200});
 });
 it("refuses fractional pennies before any save",async()=>{
  const db={rpc:vi.fn()};await expect(saveAtomicCosting(db as never,"company",saved,{...mapCostingRates(saved),labourPerHour:1.005})).rejects.toThrow(/pounds and pence/);expect(db.rpc).not.toHaveBeenCalled();
 });
 it("requires reload on a stale snapshot, with no partial-write fallback",async()=>{
  const db={rpc:vi.fn().mockResolvedValue({error:{code:"40001"}})};await expect(saveAtomicCosting(db as never,"company",saved,mapCostingRates(saved))).rejects.toThrow(/Reload/);expect(db.rpc).toHaveBeenCalledTimes(1);
 });
 it("locks every rate control while saving and does not display database IDs",()=>{
  const html=renderToStaticMarkup(createElement(CostingRatesEditor,{value:mapCostingRates(saved),onChange:()=>{},saving:true,onSave:()=>{}}));
  expect(html).toContain('<fieldset disabled=""');expect(html).not.toContain('secret-id');expect(html).toContain('Material name 1');
 });
});
