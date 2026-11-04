import {SAMPLE_VARS} from '@/lib/email/templates/defaults';
import {expect,test} from '@playwright/test';
import {createSoloTenant,signedInClient} from '../../support/fixtures';
import {signIn,world} from '../helpers';
import {requireReviewerDatabase} from './require-database';
requireReviewerDatabase();
test('CJ-N6: chase and timesheet details use buttons, preview and persist without typing brackets',async({page})=>{
 const tenant=await createSoloTenant(world().runId,'cj-editor');const client=await signedInClient(tenant.admin);
 await signIn(page,tenant.admin);await page.goto('/settings');
 for(const [key,detail] of [['invoice_reminder','customer_name'],['timesheet','person_name']] as const){
  const baseline=await client.from('email_templates').select('subject,body').eq('organization_id',tenant.id).eq('key',key);expect(baseline.error).toBeNull();
  const card=page.getByTestId(`email-template-${key}`);await expect(card).toBeVisible();
  for(const label of ['Subject line','Greeting','Main message','Sign-off'])await expect(card.getByRole('group',{name:label,exact:true})).toBeVisible();
  const subject=card.getByRole('group',{name:'Subject line',exact:true});
  const removals=subject.getByRole('button',{name:/^Remove /});while(await removals.count())await removals.first().click();
  const typed=`CJ ${key} for `;expect(typed).not.toMatch(/[\[{]/);
  await subject.getByRole('textbox').fill(typed);await subject.getByRole('combobox').selectOption(detail);await subject.getByRole('button',{name:'Add detail',exact:true}).click();
  for(const value of await subject.getByRole('textbox').evaluateAll(nodes=>nodes.map(node=>(node as HTMLTextAreaElement).value)))expect(value).not.toMatch(/[\[{]/);
  const preview=card.getByTestId(`email-template-${key}-preview-subject`);await expect(preview).toContainText(typed.trim());await expect(preview).not.toContainText('{{');await expect(preview).toContainText(SAMPLE_VARS[detail]);
  const before=await client.from('email_templates').select('subject,body').eq('organization_id',tenant.id).eq('key',key);expect(before.error).toBeNull();expect(before.data).toEqual(baseline.data);
  await card.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(async()=>{const r=await client.from('email_templates').select('subject').eq('organization_id',tenant.id).eq('key',key).single();expect(r.error).toBeNull();return r.data?.subject;}).toContain(`{{${detail}}}`);
  await page.reload();await expect(card.getByRole('group',{name:'Subject line',exact:true}).getByRole('button',{name:/^Remove /})).toHaveCount(1);
  await expect(card.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
 }
 const mail=await client.from('email_history').select('id',{count:'exact',head:true}).eq('organization_id',tenant.id);expect(mail.error).toBeNull();expect(mail.count).toBe(0);
});
