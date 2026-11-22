import { expect, it } from "vitest";
import { readSetupProgress, setupProgressFor, writeSetupProgress, SETUP_STEPS } from "@/lib/company-setup/progress";
import { FakeDb } from "../support/fake-db";
it("a new company gets no other company's progress or records", async () => {
 const db = new FakeDb({ company_setup_progress: [{ organization_id: "other", step: "company", completed: true }], customers: [{ organization_id: "other", name: "Private customer" }] });
 expect(await readSetupProgress(db as never,"new")).toEqual({});
 expect(db.log).toEqual([]);
 expect(db.rows("customers")).toHaveLength(1);
});
it("filters a foreign row defensively even if a client returns one", () => {
 expect(setupProgressFor("new",[{organization_id:"other",step:"people",completed:true}])).toEqual({});
});
it("marks only one step for this company without overwriting another company", async () => {
 const db = new FakeDb({company_setup_progress:[{organization_id:"other",step:"people",completed:true}]});
 await writeSetupProgress(db as never,"new","people",true);
 expect(await readSetupProgress(db as never,"new")).toEqual({people:true});
 expect(await readSetupProgress(db as never,"other")).toEqual({people:true});
 await writeSetupProgress(db as never,"new","people",false);
 expect(await readSetupProgress(db as never,"other")).toEqual({people:true});
});
it("puts import last and uses existing settings/users/integrations/import pages", () => {
 expect(SETUP_STEPS.at(-1)?.id).toBe("import");
 expect(new Set(SETUP_STEPS.map(s=>s.href.split('#')[0]))).toEqual(new Set(['/settings','/admin/users','/admin/integrations','/admin/data']));
});
it("accounting connections hint names only Xero, not Sage or QuickBooks", () => {
 const hint = SETUP_STEPS.find(s=>s.id==="connections")?.hint ?? "";
 expect(hint).toContain("Xero");
 expect(hint).not.toMatch(/Sage|QuickBooks/);
});
