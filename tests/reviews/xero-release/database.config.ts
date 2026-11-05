import path from 'node:path';
import {defineConfig} from 'vitest/config';
const root=process.env.XERO_REVIEW_ROOT??'/workspace/work/xero-candidate-snapshot';
export default defineConfig({resolve:{alias:{'@':root}},test:{root,include:['tests/db/xero-launch-hold-149.test.ts','tests/db/xero-launch-paths-149.test.ts'],setupFiles:[path.join(__dirname,'paths.setup.ts')],fileParallelism:false,testTimeout:120000,hookTimeout:240000}});
