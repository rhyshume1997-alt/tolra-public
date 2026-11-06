import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
export class Disposable {
  readonly nonce = randomUUID();
  readonly name = `tolra-b5-financial-${this.nonce}`;
  readonly image = 'postgres@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1';
  readonly evidence = path.join(process.env.CI ? path.join(process.cwd(),'test-results') : '/tmp',this.name);
  private id = '';
  private runs: unknown[] = [];
  private environment = { ...process.env };
  constructor() {
    for (const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete this.environment[key];
  }
  private command(args: string[], input?: string) {
    return spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{ input, env: this.environment, encoding: 'utf8', maxBuffer: 8*1024*1024 });
  }
  private checked(args: string[]) {
    const r = this.command(args); if (r.status !== 0) throw new Error(r.stderr || String(r.error)); return r.stdout.trim();
  }
  async start() {
    mkdirSync(this.evidence,{recursive:true});
    this.id = this.checked(['run','-d','--pull=never','--network','none','--name',this.name,'--label',`tolra.disposable=${this.nonce}`,'--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust',this.image]);
    writeFileSync(path.join(this.evidence,'creation.json'),JSON.stringify(this.containerIdentity(),null,2));
    const attempts: unknown[] = [];
    for (let i=0;i<100;i++) {
      const ready = this.command(['exec',this.name,'psql','-h','127.0.0.1','-U','postgres','-AtX','-c','SELECT 1']);
      attempts.push({ time:new Date().toISOString(), exit_code:ready.status, stdout:ready.stdout, stderr:ready.stderr });
      writeFileSync(path.join(this.evidence,'readiness.json'),JSON.stringify(attempts,null,2));
      if (ready.status === 0) { this.identity(); return; }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw new Error('New disposable database did not become ready');
  }
  private containerIdentity() {
    const c = JSON.parse(this.checked(['inspect',this.name]))[0];
    if (c.Id !== this.id || c.Config.Image !== this.image || c.Config.Labels?.['tolra.disposable'] !== this.nonce
      || c.HostConfig.NetworkMode !== 'none' || Object.keys(c.HostConfig.PortBindings || {}).length || !c.HostConfig.Tmpfs?.['/var/lib/postgresql/data']) throw new Error('Disposable identity mismatch');
    return { container: this.id, nonce: this.nonce, image: this.image, network: 'none', ports: [] };
  }
  identity() {
    const receipt = this.containerIdentity();
    if (this.checked(['exec',this.name,'psql','-U','postgres','-AtX','-c','SELECT current_database(),current_user']) !== 'postgres|postgres') throw new Error('Database identity mismatch');
    return receipt;
  }
  sql(text: string) {
    const environment = this.identity();
    const time = new Date().toISOString();
    const r = this.command(['exec','-i',this.name,'psql','-U','postgres','-AtX','-v','ON_ERROR_STOP=1'],text);
    const log = `${r.stdout}\n${r.stderr}`;
    const index = this.runs.length;
    writeFileSync(path.join(this.evidence,`${index}.log`),log);
    this.runs.push({ time, environment, commit: spawnSync('git',['rev-parse','HEAD'],{ encoding:'utf8' }).stdout.trim(), sql_sha256: createHash('sha256').update(text).digest('hex'), exit_code: r.status, log_sha256: createHash('sha256').update(log).digest('hex') });
    writeFileSync(path.join(this.evidence,'runs.json'),JSON.stringify(this.runs,null,2));
    return { code: r.status, output: r.stdout.trim(), error: r.stderr };
  }
  ok(text: string) { const r = this.sql(text); if (r.code !== 0) throw new Error(r.error); return r.output; }
  async parallelSql(text: string) {
    const environment = this.identity(), time = new Date().toISOString();
    const result = await new Promise<{ code:number|null; output:string; error:string }>((resolve,reject) => {
      const child = spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',this.name,'psql','-U','postgres','-AtX','-v','ON_ERROR_STOP=1'],{ env:this.environment });
      let output='', error='';
      child.stdout.on('data',chunk=>{ output+=chunk; }); child.stderr.on('data',chunk=>{ error+=chunk; });
      child.on('error',reject); child.on('close',code=>resolve({ code,output:output.trim(),error })); child.stdin.end(text);
    });
    const log=`${result.output}\n${result.error}`, index=this.runs.length;
    writeFileSync(path.join(this.evidence,`${index}.log`),log);
    this.runs.push({ time, environment, commit:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(), sql_sha256:createHash('sha256').update(text).digest('hex'), exit_code:result.code, log_sha256:createHash('sha256').update(log).digest('hex') });
    writeFileSync(path.join(this.evidence,'runs.json'),JSON.stringify(this.runs,null,2));
    return result;
  }
  enableCliTls(){
    this.identity();this.checked(['exec','-u','postgres',this.name,'openssl','req','-x509','-nodes','-newkey','rsa:2048','-subj','/CN=localhost','-days','1','-keyout','/var/lib/postgresql/data/server.key','-out','/var/lib/postgresql/data/server.crt']);
    this.checked(['exec','-u','postgres',this.name,'chmod','600','/var/lib/postgresql/data/server.key']);
    this.ok("ALTER SYSTEM SET ssl='on'; SELECT pg_reload_conf();");
  }
  cli(bin:string,workdir:string){
    const environment=this.identity(),time=new Date().toISOString();
    this.checked(['exec',this.name,'mkdir','-p','/tmp/b5-cli']);
    this.checked(['cp',bin,`${this.name}:/tmp/supabase-cli`]);
    this.checked(['cp',`${workdir}/.`,`${this.name}:/tmp/b5-cli`]);
    this.identity();
    const r=this.command(['exec','-w','/tmp/b5-cli',this.name,'/tmp/supabase-cli','migration','up','--include-all','--db-url','postgresql://postgres@127.0.0.1/postgres']);
    const log=`${r.stdout}\n${r.stderr}`,index=this.runs.length;
    writeFileSync(path.join(this.evidence,`${index}-cli.log`),log);
    this.runs.push({commit:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),time,environment,command:'CLI2.40.7 migration up inside owned isolated container',sql_sha256:createHash('sha256').update(readFileSync(path.join(workdir,'supabase/migrations/143_costing_rates.sql'))).digest('hex'),exit_code:r.status,log_sha256:createHash('sha256').update(log).digest('hex')});
    writeFileSync(path.join(this.evidence,'runs.json'),JSON.stringify(this.runs,null,2));
    return {code:r.status,log,time};
  }
  stop() { if (this.id) { this.containerIdentity(); this.checked(['rm','-fv',this.name]); this.id=''; } }
}
