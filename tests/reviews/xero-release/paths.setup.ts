// Only Auth-admin fixture creation is replaced: no running Auth HTTP service in this disposable PostgreSQL rehearsal.
// Routes, engine, transport stub, role simulation and production SQL are the pinned candidate's unchanged files.
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import type {Client} from 'pg';
const {fixturePath}=vi.hoisted(()=>({fixturePath:`${process.env.XERO_REVIEW_ROOT??'/workspace/work/xero-candidate-snapshot'}/tests/support/fixtures.ts`}));
vi.mock(fixturePath, async (importOriginal) => {
 const actual=await importOriginal<{withDb:<T>(fn:(db:Client)=>Promise<T>)=>Promise<T>}>();
 return {...actual,createSoloTenant:async (runId:string,label:string)=>{
  const id=randomUUID(),email=`admin.${label}.${runId}@example.test`,slug=`t-${runId}-${label}`,name=`Synthetic ${label} ${runId}`;
  const org=await actual.withDb(async db=>{
   await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,email]);
   return (await db.query('SELECT public.create_organization($1,$2,$3,$4::jsonb) AS id',[name,slug,email,JSON.stringify({documentName:name,addressLines:['Synthetic'],email,vatRegistered:true,vatNumber:'GB000000000',defaultVatRate:20})])).rows[0].id as string;
  });
  return {id:org,slug,name,admin:{id,email,password:'unused-synthetic-password',role:'admin'}};
 }};
});
