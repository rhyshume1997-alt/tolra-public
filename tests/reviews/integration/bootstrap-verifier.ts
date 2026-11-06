/** Test setup only: check the immutable Code baseline while stronger active semantic checks run as tests.
 * This never changes a migration or turns a false active check into true. Without the explicit pinned env it uses the active verifier.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
export const INTEGRATION_BASE='e7c4b6380964386e66e5d6a67ed37ad0aaed8da5';
export function bootstrapVerifier(file:string):string{
 if(!/^supabase\/verify\/[a-zA-Z0-9_]+\.sql$/.test(file))throw new Error('Invalid verification fixture path');
 if(process.env.INTEGRATION_VERIFY_BASE!==INTEGRATION_BASE)return readFileSync(file,'utf8');
 execFileSync('git',['diff','--exit-code',INTEGRATION_BASE,'--','supabase/migrations','supabase/proposals','supabase/release','supabase/release-plan.json'],{stdio:'pipe'});
 return execFileSync('git',['show',`${INTEGRATION_BASE}:${file}`],{encoding:'utf8'});
}
