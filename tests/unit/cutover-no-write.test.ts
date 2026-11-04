import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {fakeDryRun} from '../../scripts/cutover-dry-run/check.mjs';
it('runs the existing analyser and reconciliation on fake files without changes',async()=>{
 const r=await fakeDryRun();expect(r).toMatchObject({fakeDataOnly:true,databaseConnected:false,databaseWrites:0,fileWrites:0,inputUnchanged:true,releaseApproved:false,status:'FAKE RUN COMPLETED'});
 expect(r.reconciliation.status).toBe('INCOMPLETE');expect(r.reconciliation.counts.UNVERIFIED).toBe(1);expect(r.reconciliation.outstanding).toEqual([{code:'wip_valuation',severity:'UNVERIFIED',reason:expect.stringContaining('accountant to confirm')}]);expect(r.reconciliation.counts.BLOCKER).toBe(0);expect(Object.keys(r.inputHashes.source).length).toBeGreaterThan(10);
});
it('is deterministic without timestamps or generated IDs',async()=>expect(await fakeDryRun()).toEqual(await fakeDryRun()));
it('does not load the database writer',async()=>{vi.resetModules();vi.doMock('../../scripts/sliq-import/write.mjs',()=>{throw Error('writer loaded');});const {fakeDryRun:run}=await import('../../scripts/cutover-dry-run/check.mjs');expect((await run()).databaseWrites).toBe(0);vi.doUnmock('../../scripts/sliq-import/write.mjs');});
it.each(['--write','--database-url=postgres://example','--out=/tmp/report','real-customer.csv'])('rejects %s before running',arg=>{const p=spawnSync(process.execPath,['scripts/cutover-dry-run/cli.mjs',arg],{encoding:'utf8'});expect(p.status).toBe(2);expect(p.stdout).toBe('');expect(p.stderr).toContain('REFUSED');});
it('CLI reports fake-only, zero writes and no approval',()=>{const r=JSON.parse(execFileSync(process.execPath,['scripts/cutover-dry-run/cli.mjs'],{encoding:'utf8'}));expect(r).toMatchObject({databaseWrites:0,fileWrites:0,releaseApproved:false,inputUnchanged:true});});
it('has no write, network or database entry point in the wrapper',()=>{const code=readFileSync('scripts/cutover-dry-run/check.mjs','utf8');expect(code).not.toMatch(/from ['"](?:pg|node:(?:net|http|https)|.*\/write\.mjs|.*\/cli\.mjs)['"]/);});
