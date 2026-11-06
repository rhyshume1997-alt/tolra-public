import {expect,it} from 'vitest';
import {withDb} from '../../support/fixtures';
it('final151 schema retains exact half-up integer pence above JavaScript safe integer range',async()=>{
 await withDb(async db=>{
  for(const [n,d,result] of [['1','2','1'],['13','100','0'],['135','10','14'],['9007199254740993','2','4503599627370497'],['18446744073709551613','2','9223372036854775807']])
   expect((await db.query('select job_cost_round($1::numeric,$2::numeric)::text as p',[n,d])).rows[0].p).toBe(result);
  expect((await db.query("select to_regprocedure('public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)') is not null as ready")).rows[0].ready).toBe(true);
  expect((await db.query("select to_regprocedure('public.ai_helper_tolra_remove_key(uuid,text)') is not null as ready")).rows[0].ready).toBe(true);
 });
});
