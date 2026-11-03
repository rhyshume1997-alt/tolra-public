import { expect, test } from "@playwright/test";
import { adminClient, createSoloTenant } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { signIn, world } from "../helpers";

test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);

for(const key of ["invoice_reminder","timesheet"]) test(`N6: ${key} has labelled sections, detail buttons, live preview and durable saved text`,async({page})=>{
  const tenant=await createSoloTenant(world().runId,`n6-${key.replaceAll("_","-")}`);
  await signIn(page,tenant.admin);await page.goto("/settings");
  const card=page.getByTestId(`email-template-${key}`);
  for(const label of ["Subject line","Greeting","Main message","Sign-off"]) await expect(card.getByRole("group",{name:label,exact:true})).toBeVisible();
  const message=card.getByRole("group",{name:"Main message",exact:true});
  const marker=`Please check this ${world().runId}`;
  await message.getByRole("textbox").first().fill(marker);
  const greeting=card.getByRole("group",{name:"Greeting",exact:true});
  const detail=key==="invoice_reminder"?"customer_name":"person_name";
  await greeting.getByRole("combobox").selectOption(detail);
  await greeting.getByRole("button",{name:"Add detail",exact:true}).click();
  // User inserts a named detail by clicking; no brackets are typed in this test.
  await expect(card.getByTestId(`email-template-${key}-preview-body`)).toContainText(marker);
  await expect(card.getByTestId(`email-template-${key}-preview-body`)).not.toContainText("{{");
  const read=()=>adminClient().from("email_templates").select("subject,body").eq("organization_id",tenant.id).eq("key",key).maybeSingle();
  const before=await read();expect(before.error).toBeNull();expect(before.data).toBeNull();
  await card.getByRole("button",{name:"Save",exact:true}).click();
  await expect(card).toContainText("Your own text");
  const saved=await read();expect(saved.error).toBeNull();expect(saved.data?.body).toContain(marker);
  expect(saved.data?.body).toContain(`{{${detail}}}`);
  await page.reload();await expect(card).toContainText("Your own text");
  await expect(card.getByTestId(`email-template-${key}-preview-body`)).toContainText(marker);
  await card.getByRole("button",{name:"Reset to default",exact:true}).click();
  await expect(card).toContainText("Default text");expect((await read()).data).toBeNull();
});

test("N6: changing a template never rewrites an email already waiting for approval",async({page})=>{
  const tenant=await createSoloTenant(world().runId,"n6-review");
  const original={organization_id:tenant.id,to_email:"synthetic@example.test",subject:"The reviewed subject",body:"The exact reviewed body",status:"drafted",related_to_type:"general"};
  const created=await adminClient().from("email_history").insert(original).select("id").single();
  expect(created.error).toBeNull();
  await signIn(page,tenant.admin);await page.goto("/settings");
  const card=page.getByTestId("email-template-invoice_reminder");
  await card.getByRole("group",{name:"Main message",exact:true}).getByRole("textbox").first().fill("New wording for future drafts only");
  await card.getByRole("button",{name:"Save",exact:true}).click();await expect(card).toContainText("Your own text");
  const stored=await adminClient().from("email_history").select("subject,body,status").eq("id",created.data!.id).single();
  expect(stored.error).toBeNull();expect(stored.data).toEqual({subject:original.subject,body:original.body,status:"drafted"});
  await page.goto("/approval");await expect(page.getByText(original.subject,{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Full preview",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText(original.body);
});
