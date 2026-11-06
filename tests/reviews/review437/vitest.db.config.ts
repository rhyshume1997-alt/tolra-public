import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/review437/*.db.test.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:30000,hookTimeout:180000}});
