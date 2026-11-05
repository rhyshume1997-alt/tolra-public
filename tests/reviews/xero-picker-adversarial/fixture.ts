import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {Client} from 'pg';
import {ctx} from './route.setup';
export const nonce='picker_adv_'+randomUUID().replaceAll('-','');
const admin=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:'postgres'});
export const db=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:nonce});
export const receipt:{subject:string;database:string;files:Array<{file:string;sha256:string}>;server?:string}={subject:'cab1bbe19a16b6575c6680a35fe25820631e5f20',database:nonce,files:[]};
export const sql=(file:string)=>{const text=readFileSync(path.resolve(file),'utf8');receipt.files.push({file,sha256:createHash('sha256').update(text).digest('hex')});return text;};
export async function start(){
 await admin.connect();await admin.query(`create database ${nonce}`);await db.connect();receipt.server=(await db.query('select version() as v')).rows[0].v;
 ctx.url=`postgresql://xero_test@127.0.0.1:54849/${nonce}`;
 await db.query(sql('tests/reviews/xero-picker-adversarial/bootstrap.sql'));
 for(const f of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=137).sort())await db.query(sql('supabase/migrations/'+f));
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 for(const phase of [...plan.jnr_cutover_numbered_order,...plan.phases]){await db.query(sql(phase.release));const rows=(await db.query(sql(phase.verify))).rows;if(!rows.length||rows.some(r=>(r.ok??r.passed)!==true))throw Error('Prerequisite verification failed '+phase.number);}
 await db.query(sql('supabase/release/151_xero_invite_hardening.release.sql'));
 for(const [key,value] of Object.entries({XERO_CLIENT_ID:'synthetic-client',XERO_CLIENT_SECRET:'synthetic-secret',XERO_REDIRECT_URI:'https://tolra.example.test/api/integrations/xero/callback',NEXT_PUBLIC_SITE_URL:'https://tolra.example.test',XERO_INVITE_REDIRECT_URIS:'https://tolra.example.test/api/integrations/invite/callback',INTEGRATIONS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}))process.env[key]=value;
}
export async function stop(){
 mkdirSync('tests/reviews/xero-picker-adversarial/evidence',{recursive:true});writeFileSync('tests/reviews/xero-picker-adversarial/evidence/database-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 await db.end().catch(()=>undefined);await admin.query(`drop database if exists ${nonce} with (force)`);await admin.end();
}
export type Actor={id:string;org:string;session:string;role:string};
export async function company(label:string):Promise<Actor>{
 const org=randomUUID(),id=randomUUID(),session=randomUUID(),email=`${id}@example.test`;
 await db.query("insert into organizations(id,name,slug,status) values($1,$2,$3,'active')",[org,`Synthetic ${label}`,`t-invite-${org}`]);
 await db.query('insert into auth.users(id,email) values($1,$2)',[id,email]);
 await db.query("insert into user_profiles(id,email,full_name,role,organization_id,active,must_change_password) values($1,$2,'Synthetic','admin',$3,true,false)",[id,email,org]);
 await db.query("insert into organization_members(user_id,organization_id,role,active) values($1,$2,'admin',true)",[id,org]);
 await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,id]);await db.query('insert into security_audit.session_company(session_id,user_id,organization_id) values($1,$2,$3)',[session,id,org]);return {id,org,session,role:'admin'};
}
export async function as(who:Actor,query:string,args:unknown[]=[]){
 const client=new Client({connectionString:ctx.url});await client.connect();try{await client.query('begin');await client.query('set local role authenticated');await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:who.id,session_id:who.session,role:'authenticated',aal:'aal2',amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]})]);const result=await client.query(query,args);await client.query('commit');return result;}finally{await client.end();}
}
