import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/verify-old-base/*.db.test.ts'],maxWorkers:1,minWorkers:1,testTimeout:120000,hookTimeout:180000}});
