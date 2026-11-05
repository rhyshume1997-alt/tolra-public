import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {Client} from 'pg';
export const nonce='release151_adv_'+randomUUID().replaceAll('-','');
const admin=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:'postgres'});
export const db=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:nonce});
export const receipt:{subject:string;database:string;files:Array<{file:string;sha256:string}>;server?:string}={subject:'656a79390650fe87a6e7513679246e82df3f3a40',database:nonce,files:[]};
export const sql=(file:string)=>{const text=readFileSync(path.resolve(file),'utf8');receipt.files.push({file,sha256:createHash('sha256').update(text).digest('hex')});return text;};
export async function start(){
 await admin.connect();await admin.query(`create database ${nonce}`);await db.connect();receipt.server=(await db.query('select version() as v')).rows[0].v;

 await db.query(sql('tests/reviews/night-151-package/bootstrap.sql'));
 for(const f of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=137).sort())await db.query(sql('supabase/migrations/'+f));
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 for(const phase of [...plan.jnr_cutover_numbered_order,...plan.phases]){await db.query(sql(phase.release));const rows=(await db.query(sql(phase.verify))).rows;if(!rows.length||rows.some(r=>(r.ok??r.passed)!==true))throw Error('Prerequisite verification failed '+phase.number);}
 await db.query('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key)');
 for(const [key,value] of Object.entries({XERO_CLIENT_ID:'synthetic-client',XERO_CLIENT_SECRET:'synthetic-secret',XERO_REDIRECT_URI:'https://tolra.example.test/api/integrations/xero/callback',NEXT_PUBLIC_SITE_URL:'https://tolra.example.test',XERO_INVITE_REDIRECT_URIS:'https://tolra.example.test/api/integrations/invite/callback',INTEGRATIONS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}))process.env[key]=value;
}
export async function stop(){
 mkdirSync('tests/reviews/night-151-package/evidence',{recursive:true});writeFileSync('tests/reviews/night-151-package/evidence/database-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 await db.end().catch(()=>undefined);await admin.query(`drop database if exists ${nonce} with (force)`);await admin.end();
}
