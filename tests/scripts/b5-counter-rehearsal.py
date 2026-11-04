"""Narrow synthetic fixture for real cutover SQL and 147 numbering guard; NOT full-app validation.
No URL accepted. A new isolated container is identified before the first SQL write and before every later statement.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import datetime, hashlib, json, os, re, subprocess, sys, time, uuid

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(sys.argv[1]).resolve();OUT.mkdir(parents=True,exist_ok=False)
NONCE=uuid.uuid4().hex;NAME='tolra-b5-counter-'+NONCE[:12]
IMAGE='postgres@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1'
DOCKER=['docker','--host=unix:///var/run/docker.sock']
ENV={k:v for k,v in os.environ.items() if k not in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']}
J='11111111-1111-4111-8111-111111111111';M='22222222-2222-4222-8222-222222222222'
evidence=[];checks=[];started=time.monotonic();cid=None
def cmd(args,stdin=None):
 r=subprocess.run(args,input=stdin,text=True,capture_output=True,env=ENV)
 return r
def identity():
 d=json.loads(subprocess.check_output(DOCKER+['inspect',NAME],text=True,env=ENV))[0]
 assert d['Id']==cid and d['Config']['Labels'].get('tolra.b5.nonce')==NONCE
 assert d['Config']['Image']==IMAGE and d['HostConfig']['NetworkMode']=='none' and not d['HostConfig']['PortBindings']
 return {'container':cid,'nonce':NONCE,'image_id':d['Image'],'network':'none','ports':[]}
def sql(text,params=(),ref='fixture',allow_failure=False,first=False):
 identity()
 if not first:
  marker=cmd(DOCKER+['exec',NAME,'psql','-U','postgres','-AtX','-c','select nonce from b5_guard.identity'])
  assert marker.returncode==0 and marker.stdout.strip()==NONCE,'disposable marker mismatch'
 args=DOCKER+['exec','-i',NAME,'psql','-U','postgres','-AtX','-v','ON_ERROR_STOP=1']
 for key,value in params:args+=['-v',key+'='+value]
 t=time.monotonic();r=cmd(args,text)
 entry={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':ref,'sql_sha256':hashlib.sha256(text.encode()).hexdigest(),'exit_code':r.returncode,'seconds':round(time.monotonic()-t,4),'stdout':r.stdout,'stderr':r.stderr}
 evidence.append(entry)
 if not allow_failure:assert r.returncode==0,r.stderr
 return r
def cut(name,last=None,ok=True):
 path=ROOT/'supabase/cutover'/name
 params=[('company_slug','t-b5-jnr')]+([('last_pad_number',str(last))] if last is not None else [])
 r=sql(path.read_text(),params,str(path.relative_to(ROOT)),True)
 assert (r.returncode==0)==ok,r.stderr
 return r
def snapshot():
 return sql("select json_build_object('c',(select json_agg(t order by organization_id,prefix) from public.doc_counters t),'h',(select json_agg(t order by organization_id) from public.dln_numbering_pending t),'n',(select json_agg(t order by id) from public.delivery_notes t))").stdout.strip()
def check(name,fn):
 try:fn();checks.append({'id':name,'result':'passed'})
 except Exception as e:checks.append({'id':name,'result':'failed','error':str(e)});raise
try:
 assert cmd(DOCKER+['ps','-aq','--filter','name=^'+NAME+'$']).stdout.strip()==''
 r=cmd(DOCKER+['run','-d','--network','none','--label','tolra.b5.nonce='+NONCE,'--name',NAME,'-e','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE]);assert r.returncode==0,r.stderr
 cid=r.stdout.strip()
 for _ in range(100):
  if cmd(DOCKER+['exec',NAME,'pg_isready','-U','postgres']).returncode==0:break
  time.sleep(.1)
 else:raise RuntimeError('database did not start')
 receipt=identity()
 # Read-only initial check plus external container receipt BEFORE the first application SQL write.
 reads=[]
 for _ in range(50):
  initial=cmd(DOCKER+['exec',NAME,'psql','-U','postgres','-AtX','-c',"select current_database(),current_user,(select count(*) from information_schema.tables where table_schema='public')"])
  reads.append({'exit_code':initial.returncode,'stdout':initial.stdout,'stderr':initial.stderr})
  (OUT/'initial-read-attempts.json').write_text(json.dumps(reads,indent=2))
  if initial.returncode==0:break
  time.sleep(.1)
 assert initial.returncode==0 and initial.stdout.strip()=='postgres|postgres|0',initial.stdout+initial.stderr
 (OUT/'identity.json').write_text(json.dumps({**receipt,'initial_readonly':initial.stdout.strip()},indent=2))
 sql(f"create schema b5_guard; create table b5_guard.identity(nonce text primary key); insert into b5_guard.identity values('{NONCE}'); revoke all on schema b5_guard from public;",first=True)
 sql(f"""create schema security_audit;
 create table public.organizations(id uuid primary key,slug text unique,name text);
 create table public.doc_counters(organization_id uuid,prefix text,last int,primary key(organization_id,prefix));
 create table public.dln_numbering_pending(organization_id uuid primary key);
 create table public.delivery_notes(id bigint generated always as identity,organization_id uuid,dn_number text,created_at timestamptz default clock_timestamp());
 create table security_audit.audit_log(id bigint generated always as identity,organization_id uuid,actor_email text,action text,entity_table text,entity_id text,old_data jsonb,new_data jsonb,metadata jsonb,created_at timestamptz default clock_timestamp());
 insert into public.organizations values('{J}','t-b5-jnr','Synthetic JNR'),('{M}','t-b5-marpet','Synthetic Marpet');
 insert into public.doc_counters values('{J}','DLN',0),('{M}','DLN',77);
 insert into public.dln_numbering_pending values('{J}'),('{M}');
 create role authenticated; create role anon;
 grant usage on schema public to authenticated; grant insert,select on public.delivery_notes to authenticated;grant usage on all sequences in schema public to authenticated;
 create function public.next_doc_number(text) returns text language plpgsql as $$declare n int;begin update public.doc_counters set last=last+1 where organization_id='{J}' and prefix='DLN' returning last into n;return 'DLN-'||lpad(n::text,4,'0');end$$;
 """)
 source=(ROOT/'supabase/release/147_job_delivery_note.release.sql').read_text()
 guard=source[source.index('CREATE FUNCTION public.delivery_notes_numbering_guard()'):source.index('-- 4. A delivery note')]
 sql(guard,ref='147 numbering guard, byte slice of reviewed source')
 marpet=sql(f"select row_to_json(c) from public.doc_counters c where organization_id='{M}'").stdout
 before=snapshot();cut('set_dln_next_number.sql','-1',False);assert snapshot()==before
 checks.append({'id':'invalid-number-atomic','result':'passed'})
 cut('set_dln_next_number.sql',100);checks.append({'id':'set-releases-hold','result':'passed'})
 before=snapshot();cut('set_dln_next_number.sql',200,False);assert snapshot()==before
 checks.append({'id':'repeat-refuses-atomic','result':'passed'})
 cut('undo_dln_next_number.sql');assert sql(f"select last from public.doc_counters where organization_id='{J}'").stdout.strip()=='0'
 assert sql(f"select count(*) from public.dln_numbering_pending where organization_id='{J}'").stdout.strip()=='1'
 checks.append({'id':'undo-restores-counter-and-hold','result':'passed'})
 def race(n):return sql((ROOT/'supabase/cutover/set_dln_next_number.sql').read_text(),[('company_slug','t-b5-jnr'),('last_pad_number',str(n))],'concurrent day-of setter',True).returncode
 with ThreadPoolExecutor(2) as pool:codes=list(pool.map(race,[300,400]))
 assert sorted(codes)==[0,3],codes
 checks.append({'id':'concurrent-setters-one-wins','result':'passed'})
 # Normal role path rejects typed numbers. Raw custom-GUC manipulation is tested separately, never treated as a browser exploit.
 before=snapshot();r=sql(f"begin;set local role authenticated;insert into public.delivery_notes(organization_id,dn_number) values('{J}','DLN-9999');commit;",allow_failure=True)
 assert r.returncode!=0 and snapshot()==before
 checks.append({'id':'manual-typed-number-refused','result':'passed'})
 with ThreadPoolExecutor(12) as pool:
  codes=list(pool.map(lambda _:sql(f"begin;set local role authenticated;insert into public.delivery_notes(organization_id) values('{J}');commit;").returncode,range(12)))
 assert set(codes)=={0}
 assert sql(f"select count(*),count(distinct dn_number) from public.delivery_notes where organization_id='{J}'").stdout.strip()=='12|12'
 checks.append({'id':'concurrent-manual-numbering-unique','result':'passed'})
 before=snapshot();cut('undo_dln_next_number.sql',ok=False);assert snapshot()==before
 checks.append({'id':'undo-after-use-refused-atomic','result':'passed'})
 assert sql(f"select row_to_json(c) from public.doc_counters c where organization_id='{M}'").stdout==marpet
 checks.append({'id':'synthetic-marpet-counter-unchanged','result':'passed'})
 # Adversarial expectation: even the role must not be able to supply its own number. A success is preserved as a finding.
 for setting,value in [('quoteflow.delivery_note_new','on'),('quoteflow.data_import',J)]:
  before=snapshot();r=sql(f"begin;set local role authenticated;select set_config('{setting}','{value}',true);insert into public.delivery_notes(organization_id,dn_number) values('{J}','DLN-BYPASS-{len(checks)}');commit;",allow_failure=True)
  checks.append({'id':'forged-'+setting,'result':'failed' if r.returncode==0 else 'passed','expected':'refused with no state change','changed':snapshot()!=before})
 # Dump/restore the fixture only; compare every app table and functions. Not a Supabase/storage backup proof.
 dump=cmd(DOCKER+['exec',NAME,'pg_dump','-U','postgres','--schema=public','--schema=security_audit','--no-owner','--no-privileges','--clean','--if-exists']);assert dump.returncode==0
 dump_hash=hashlib.sha256(dump.stdout.encode()).hexdigest()
 # Restore target is a NEW database in this same nonce-verified isolated container.
 sql('create database b5_restored;')
 identity()
 empty=cmd(DOCKER+['exec',NAME,'psql','-U','postgres','-d','b5_restored','-AtX','-c',"select current_database(),(select count(*) from information_schema.tables where table_schema='public')"])
 assert empty.returncode==0 and empty.stdout.strip()=='b5_restored|0','restore target not the newly created empty database'
 t=time.monotonic();restore=cmd(DOCKER+['exec','-i',NAME,'psql','-U','postgres','-d','b5_restored','-X','-v','ON_ERROR_STOP=1'],dump.stdout)
 evidence.append({'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'synthetic fixture pg_dump --clean --if-exists','sql_sha256':dump_hash,'exit_code':restore.returncode,'seconds':round(time.monotonic()-t,4),'stdout':restore.stdout,'stderr':restore.stderr})
 assert restore.returncode==0,restore.stderr
 comparisons=[(table,f"select coalesce(json_agg(t order by to_jsonb(t)::text)::text,'[]') from {table} t") for table in ['public.organizations','public.doc_counters','public.dln_numbering_pending','public.delivery_notes','security_audit.audit_log']]
 comparisons += [
  ('functions',"select n.nspname,p.proname,pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','security_audit') order by 1,2,3"),
  ('indexes',"select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','security_audit') order by 1,2,3"),
  ('constraints',"select n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','security_audit') order by 1,2,3"),
  ('sequences',"select schemaname,sequencename,last_value from pg_sequences where schemaname in ('public','security_audit') order by 1,2"),
 ]
 for table,query in comparisons:
  original=cmd(DOCKER+['exec',NAME,'psql','-U','postgres','-AtX','-c',query]);restored=cmd(DOCKER+['exec',NAME,'psql','-U','postgres','-d','b5_restored','-AtX','-c',query]);assert original.stdout==restored.stdout
 checks.append({'id':'fixture-object-restore','result':'passed','dump_sha256':dump_hash,'recovery_seconds':round(time.monotonic()-t,4),'compared':[x[0] for x in comparisons],'scope':'all five fixture tables plus functions/indexes/constraints/sequences; not full app/storage/roles'})
finally:
 (OUT/'sql-runs.json').write_text(json.dumps(evidence,indent=2))
 (OUT/'results.json').write_text(json.dumps({'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'checks':checks,'duration_seconds':round(time.monotonic()-started,3)},indent=2))
 if cid:
  identity();cmd(DOCKER+['rm','-fv',NAME])
print(json.dumps(checks,indent=2))
sys.exit(1 if any(c['result']=='failed' for c in checks) else 0)
