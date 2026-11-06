import {readFileSync} from 'node:fs';
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

it.each([
 ['1','2','1'],['5','2','3'],['9007199254740993','2','4503599627370497'],
 ['18446744073709551613','2','9223372036854775807'],
 ['999999999999999999','1000000000','1000000000'],['999999999499999999','1000000000','999999999'],
])('exact numeric ratio %s/%s rounds to integer pence %s without floating-point conversion',async(n,d,want)=>{
 expect((await db.query('select job_cost_round($1::numeric,$2::numeric)::text as p',[n,d])).rows[0].p).toBe(want);
});
it.each([['-1','2'],['1','0'],['1.5','2'],['1','1.5']])('invalid cost ratio %s/%s is refused, never rounded into a cost',async(n,d)=>{
 await expect(db.query('select job_cost_round($1::numeric,$2::numeric)',[n,d])).rejects.toMatchObject({code:'22023'});
});
it('missing cost remains null and an unrepresentable bigint is refused rather than losing precision',async()=>{
 expect((await db.query('select job_cost_round(null,2) as p')).rows[0].p).toBeNull();
 await expect(db.query('select job_cost_round(18446744073709551615,2)')).rejects.toMatchObject({code:'22003'});
});
it('changing the rounding function preserves historical snapshot bytes and prices only open jobs with the new rule',async()=>{
 await db.query('begin');try{
  const current=(await db.query("select pg_get_functiondef('public.job_cost_round(numeric,numeric)'::regprocedure) as definition")).rows[0].definition;
  const source=readFileSync('tests/reviews/night-cost-profit/legacy-half-even-round.sql','utf8');
  const legacy=source.match(/CREATE FUNCTION public\.job_cost_round\([\s\S]*?\$\$;/)?.[0];expect(legacy).toBeDefined();
  await db.query(legacy!.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  const c=await company(db,'legacy-half-penny');expect((await save143(db,c.admin,{labour:0,overhead:100,machines:[{id:c.haas,name:'Haas',hourly:1,labour:0}]})).error).toBeUndefined();
  const closed=await workedJob(db,c);await db.query("update jobs set finished_at=now(),stage='complete' where id=$1",[closed]);await db.query('set constraints all immediate');
  const snapshot=async()=>(await db.query('select to_jsonb(s) as row from job_cost_snapshots s where job_id=$1',[closed])).rows[0].row;
  const before=await snapshot();expect(before.machine_pence).toBe(0);
  await db.query(current);expect(await snapshot()).toEqual(before);
  const historical=await inputs(db,c.office,closed);expect(historical.open).toBe(false);expect(historical.live??null).toBeNull();expect(historical.snapshot?.machine_pence).toBe(0);
  const open=await workedJob(db,c);expect((await inputs(db,c.office,open)).live?.machine_pence).toBe(1);expect(await snapshot()).toEqual(before);
 }finally{await db.query('rollback');}
});
