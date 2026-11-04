import {expect,test} from '@playwright/test';
import {adminClient,createSoloTenant,signedInClient} from '../../support/fixtures';
import {signIn,world} from '../helpers';
import {requireReviewerDatabase} from './require-database';
requireReviewerDatabase();
test('CJ-N5: blank company keeps its setup across all four screens and never sees another company',async({page})=>{
 const a=await createSoloTenant(world().runId,'cj-blank',undefined,{salesOrders:false});
 const b=await createSoloTenant(world().runId,'cj-other',undefined,{salesOrders:false});
 const marker=`CJ other customer ${world().runId}`;
 expect((await adminClient().from('customers').insert({organization_id:b.id,name:marker})).error).toBeNull();
 const own=await signedInClient(a.admin),other=await signedInClient(b.admin);
 for(const table of ['customers','jobs','invoices','quotes','sales_orders','purchase_orders']){
  const result=await own.from(table).select('id').eq('organization_id',a.id);expect(result.error).toBeNull();expect(result.data).toEqual([]);
 }
 const hidden=await own.from('customers').select('id').eq('organization_id',b.id);expect(hidden.error).toBeNull();expect(hidden.data).toEqual([]);
 await signIn(page,a.admin);await page.goto('/customers');await expect(page.getByText(marker,{exact:true})).toHaveCount(0);
 await page.goto('/settings');const guide=page.getByRole('region',{name:'Company setup',exact:true});
 await expect(guide).toBeVisible();await expect(guide.getByRole('checkbox').first()).not.toBeChecked();
 await guide.getByRole('checkbox').first().check();
 await expect.poll(async()=>{const r=await own.from('company_setup_progress').select('completed').eq('organization_id',a.id).eq('step','company').single();expect(r.error).toBeNull();return r.data?.completed;}).toBe(true);
 for(const path of ['/admin/users','/admin/integrations','/admin/data','/settings']){
  await page.goto(path);await expect(guide).toBeVisible();await expect(guide.getByRole('checkbox').first()).toBeChecked();
 }
 const cross=await other.from('company_setup_progress').select('*').eq('organization_id',a.id);expect(cross.error).toBeNull();expect(cross.data).toEqual([]);
 const untouched=await other.from('company_setup_progress').select('*').eq('organization_id',b.id);expect(untouched.error).toBeNull();expect(untouched.data).toEqual([]);
});
