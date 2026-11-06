import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {Client} from 'pg';
const database='pending_oauth_'+randomUUID().replaceAll('-','');
const settings={host:'127.0.0.1',port:54849,user:'xero_test',database};
const admin=new Client({...settings,database:'postgres'});
export const db=new Client(settings);
export type Actor={id:string;org:string;session:string};
export const cipher=()=>`v1.${randomBytes(12).toString('base64url')}.${randomBytes(16).toString('base64url')}.${randomBytes(48).toString('base64url')}`;
export async function connect(role?:'authenticated'|'service_role',actor?:Actor){
 const c=new Client(settings);await c.connect();await c.query('begin');
 if(role)await c.query(`set local role ${role}`);
 if(actor)await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.id,session_id:actor.session,role:'authenticated',aal:'aal2',amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]})]);
 return c;
}
export async function call(actor:Actor|'service',query:string,args:unknown[]=[]){const c=await connect(actor==='service'?'service_role':'authenticated',actor==='service'?undefined:actor);try{const r=await c.query(query,args);await c.query('commit');return r;}finally{await c.end();}}
export async function start(){await admin.connect();await admin.query(`create database ${database}`);await db.connect();
 await db.query(readFileSync('tests/reviews/pending-oauth/bootstrap.sql','utf8'));
 for(const f of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=137).sort())await db.query(readFileSync('supabase/migrations/'+f,'utf8'));
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 for(const phase of [...plan.jnr_cutover_numbered_order,...plan.phases]){await db.query(readFileSync(phase.release,'utf8'));const rows=(await db.query(readFileSync(phase.verify,'utf8'))).rows;if(rows.length===0||rows.some(r=>(r.ok??r.passed)!==true))throw Error('Release verifier failed:'+phase.number);}
}
export async function stop(){await db.end();await admin.query(`drop database if exists ${database} with (force)`);await admin.end();}
export async function actor():Promise<Actor>{const org=randomUUID(),id=randomUUID(),session=randomUUID();
 await db.query("insert into organizations(id,name,slug,status) values($1,'Synthetic Pending OAuth',$2,'active')",[org,'pending-'+org]);await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.test']);
 await db.query("insert into user_profiles(id,email,full_name,role,organization_id,active,must_change_password) values($1,$2,'Synthetic','admin',$3,true,false)",[id,id+'@example.test',org]);
 await db.query("insert into organization_members(user_id,organization_id,role,active) values($1,$2,'admin',true)",[id,org]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,id]);await db.query('insert into security_audit.session_company(session_id,user_id,organization_id) values($1,$2,$3)',[session,id,org]);return{id,org,session};
}
export async function invite(who:Actor){const ref=randomBytes(16).toString('base64url'),state=randomBytes(32).toString('hex');const i=(await call(who,"select integration_invite_create('xero',$1,'bound@example.test') as r",[ref])).rows[0].r;return{id:i.id as string,ref,state};}
export type Invite=Awaited<ReturnType<typeof invite>>;
export async function exchange(i:Invite){await call('service','select integration_invite_code_issue($1,$2)',[i.ref,'a'.repeat(64)]);return(await call('service','select integration_invite_code_verify($1,$2,$3,$4) as r',[i.ref,'a'.repeat(64),i.state,cipher()])).rows[0].r;}
export const consume=async(i:Invite)=>(await call('service',"select integration_oauth_consume_invite('xero',$1) as r",[i.state])).rows[0].r;
export const revoke=async(who:Actor,i:Invite)=>(await call(who,'select integration_invite_revoke($1) as r',[i.id])).rows[0].r as boolean;
export function storeArgs(who:Actor,i:Invite){return[i.state,who.org,who.id,'xero',randomUUID(),'Synthetic Pending OAuth',randomUUID(),cipher(),cipher(),new Date(Date.now()+1800000).toISOString(),1];}
export const storeQuery='select integration_invite_store_connection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r';
export const store=async(who:Actor,i:Invite)=>(await call('service',storeQuery,storeArgs(who,i))).rows[0].r;
