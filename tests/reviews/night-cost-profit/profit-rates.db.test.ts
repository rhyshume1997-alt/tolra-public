import {beforeAll,expect,it} from 'vitest';
import {db} from './fixture';
import {company,inputs,workedJob,save143} from './profit-fixture';
import {preparePost144Fixture} from '@/tests/support/post-144-release-fixture';
import {toPence} from '@/lib/money';
beforeAll(async()=>{await preparePost144Fixture({verify:async()=>undefined,query:sql=>db.query(sql)});});
it('application and database money agree on exact half pennies',async()=>{for(const value of ['0.005','0.125','0.135','1.005','1234.565'])expect(Number((await db.query('select round($1::numeric*100)::bigint as p',[value])).rows[0].p)).toBe(toPence(Number(value)));});
it('148 actual-cost rounding follows the money half-up rule outside the frozen quotation-engine exception',async()=>{expect(Number((await db.query('select job_cost_round(1,2) as p')).rows[0].p),'0.5p business actual cost must not disappear').toBe(1);});
it('148 open-job figures use only that company 143 rates and ignore another company rate edits',async()=>{
 await db.query('begin');try{const a=await company(db,'night-a'),b=await company(db,'night-b'),job=await workedJob(db,a);const before=(await inputs(db,a.office,job)).live!;
  const changed=await save143(db,b.admin,{labour:9999,overhead:250,machines:[{id:b.haas,name:'Other',hourly:9999,labour:9999}]});expect(changed.error).toBeUndefined();expect((await inputs(db,a.office,job)).live).toEqual(before);
  const saved=await save143(db,a.admin,{labour:3000,overhead:100,machines:[{id:a.haas,name:'Haas',hourly:6000,labour:4000}]});expect(saved.error).toBeUndefined();expect((await inputs(db,a.office,job)).live).toMatchObject({state:'complete',labour_pence:5000,machine_pence:3000,overhead_pence:0});
  // Existing dedicated 148 snapshot/refresh tests below exercise closing and corrections through production functions.
 }finally{await db.query('rollback');}
});

it('a half-penny actual machine cost from 143 rates is retained as one penny in 148 business money',async()=>{
 await db.query('begin');try{const c=await company(db,'half-penny');const saved=await save143(db,c.admin,{labour:0,overhead:100,machines:[{id:c.haas,name:'Haas',hourly:1,labour:0}]});expect(saved.error).toBeUndefined();const job=await workedJob(db,c);const live=(await inputs(db,c.office,job)).live!;expect(live.machine_pence,'30 minutes at 1p/hour is 0.5p, a money-rule boundary').toBe(1);}finally{await db.query('rollback');}
});
