import { expect, test } from "@playwright/test";
import { adminClient, createSoloTenant, signedInClient } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { signIn, world } from "../helpers";

test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);

test("N5: blank company, visible setup across four screens, progress survives reload", async ({page}) => {
  const run = world().runId;
  const a = await createSoloTenant(run, "n5-blank");
  const b = await createSoloTenant(run, "n5-private");
  const marker = `Private other-company customer ${run}`;
  expect((await adminClient().from("customers").insert({organization_id:b.id,name:marker})).error).toBeNull();
  for (const table of ["customers", "jobs", "invoices", "quotes"]) {
    const rows = await adminClient().from(table).select("id").eq("organization_id",a.id);
    expect(rows.error).toBeNull(); expect(rows.data).toEqual([]);
  }
  await signIn(page,a.admin);await page.goto("/settings");
  const guide = page.getByRole("region",{name:"Company setup",exact:true});
  await expect(guide).toBeVisible();await expect(guide).toContainText("0 of 9 reviewed");
  await expect(guide.getByRole("checkbox").first()).toBeEnabled();
  await guide.getByRole("checkbox").first().click();
  await expect(guide).toContainText("1 of 9 reviewed");
  for (const route of ["/admin/users","/admin/integrations","/admin/data","/settings"]) {
    await page.goto(route);await expect(guide).toBeVisible();
    await expect(guide.getByRole("checkbox").first()).toBeChecked();
    await expect(page.locator("body")).not.toContainText(marker);
  }
  await page.reload();await expect(guide.getByRole("checkbox").first()).toBeChecked();
  const client = await signedInClient(a.admin);
  for (const table of ["customers","company_setup_progress"]) {
    const foreign = await client.from(table).select("*").eq("organization_id",b.id);
    expect(foreign.error).toBeNull();expect(foreign.data).toEqual([]);
  }
});

test("N5: another company's setup ticks never appear for a fresh admin",async({page})=>{
  const a = await createSoloTenant(world().runId,"n5-ticks-a");
  const b = await createSoloTenant(world().runId,"n5-ticks-b");
  const client=await signedInClient(a.admin);
  expect((await client.from("company_setup_progress").upsert({organization_id:a.id,step:"company",completed:true})).error).toBeNull();
  await signIn(page,b.admin);await page.goto("/settings");
  const guide=page.getByRole("region",{name:"Company setup",exact:true});
  await expect(guide).toContainText("0 of 9 reviewed");
  await expect(guide.getByRole("checkbox").first()).toBeEnabled();
  await expect(guide.getByRole("checkbox").first()).not.toBeChecked();
  expect((await (await signedInClient(b.admin)).from("company_setup_progress").upsert({organization_id:a.id,step:"people",completed:true})).error).not.toBeNull();
});
