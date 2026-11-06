import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/db/xero-invite-late-write-151.test.ts'],setupFiles:['tests/reviews/late-write-races/db.setup.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:30000,hookTimeout:180000}});
