import {defineConfig} from 'vitest/config';
const root=process.env.XERO_REVIEW_ROOT??'/workspace/work/xero-candidate-snapshot';
export default defineConfig({resolve:{alias:{'@':root}},test:{root,include:['tests/db/xero-launch-hold-149.test.ts'],fileParallelism:false,testTimeout:120000,hookTimeout:240000}});
