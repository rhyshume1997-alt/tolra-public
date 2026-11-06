import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':process.env.XERO_REVIEW_ROOT??'/workspace/work/xero-candidate-snapshot'}},test:{root:path.resolve(__dirname,'../../..'),include:['tests/reviews/xero-release/companion-readback.test.ts']}});
