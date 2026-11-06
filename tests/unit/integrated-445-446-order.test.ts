import {expect,it} from 'vitest';
import ReleaseSequencer,{post144ExtraProofFiles,releaseRank} from '../support/db-release-sequencer';
it('the integrated late-write151proof cannot install releases among frozen baseline tests',async()=>{
 const late='/repo/tests/db/xero-invite-late-write-151.test.ts';
 expect(releaseRank(late)).toBe(1);
 expect(post144ExtraProofFiles).toContain('xero-invite-late-write-151.test.ts');
 const ctx={} as ConstructorParameters<typeof ReleaseSequencer>[0],seq=new ReleaseSequencer(ctx);
 const baseline={moduleId:'/repo/tests/db/zz-baseline.test.ts'},proof={moduleId:late};
 expect(await seq.sort([proof,baseline])).toEqual([baseline,proof]);
 expect(await seq.shard([proof,baseline])).toEqual([proof,baseline]);
});
