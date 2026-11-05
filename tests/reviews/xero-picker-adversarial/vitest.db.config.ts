import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/xero-picker-adversarial/*.db.test.ts'],setupFiles:['tests/reviews/xero-picker-adversarial/route.setup.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:30000,hookTimeout:180000}});
