import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/night-cost-profit/*.db.test.ts','tests/db/costing-rates-143.test.ts','tests/db/costing-save-143.test.ts','tests/db/job-profitability-148.test.ts'],setupFiles:['tests/reviews/night-cost-profit/db.setup.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:60000,hookTimeout:180000}});
