import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/combined-release-151/rollback.db.test.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:60000,hookTimeout:180000}});
