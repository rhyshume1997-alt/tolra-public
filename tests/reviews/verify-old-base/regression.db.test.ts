import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {db,start,stop} from './fixture';
const read=(p:string)=>readFileSync(p,'utf8');
const preflight=()=>read('supabase/verify/release_preflight.sql');
beforeAll(start);afterAll(stop);
it.each([13,83])('all preflight rows execute against actual numbered base %s and later releases remain not applied',async version=>{
 const name='verify_old_'+randomUUID().replaceAll('-','');const config={host:'127.0.0.1',port:54849,user:'xero_test'};
 const admin=new Client({...config,database:'postgres'});await admin.connect();await admin.query('create database '+name);const old=new Client({...config,database:name});await old.connect();
 try{
  await old.query(read('tests/reviews/verify-old-base/bootstrap.sql'));
  for(const file of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=version).sort())await old.query(read('supabase/migrations/'+file));
  await old.query('begin read only');const rows=(await old.query(preflight())).rows;expect(rows.length).toBeGreaterThan(100);
  expect(rows.find(r=>r.check==='post-144 marker 149 xero_launch_hold')?.value).not.toBe('applied');
  expect((await old.query("select to_regclass('public.integration_connections') as t")).rows[0].t).toBeNull();
 }finally{await old.query('rollback');await old.end();await admin.query('drop database '+name+' with(force)');await admin.end();}
});
it.each(['integration_connections','integration_sends'])('final preflight must fail149 when required %s disappears',async table=>{
 expect((await db.query(preflight())).rows.find(r=>r.check==='post-144 marker 149 xero_launch_hold')?.value).toBe('applied');
 await db.query('begin');try{await db.query(`alter table public.${table} rename to missing_required_test`);const rows=(await db.query(preflight())).rows;expect(rows.find(r=>r.check==='post-144 marker 149 xero_launch_hold')?.value).not.toBe('applied');}finally{await db.query('rollback');}
});
it.each([
 ['costing_materials','costing_rates_143.sql'],['xero_transfer_hold','xero_launch_hold_149.sql'],['ai_helper_tolra_control','ai_cap_key_off_150.sql'],
])('dedicated verifier must never pass after required %s disappears',async(table,file)=>{
 await db.query('begin');try{await db.query(`alter table public.${table} rename to missing_required_test`);
  let passed=false;try{const rows=(await db.query(read('supabase/verify/'+file))).rows;passed=rows.length>0&&rows.every(r=>(r.ok??r.passed)===true);}catch(e){expect(['42P01','42703','42883']).toContain((e as {code:string}).code);}
  expect(passed).toBe(false);
 }finally{await db.query('rollback');}
});
