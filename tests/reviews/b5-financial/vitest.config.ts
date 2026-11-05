import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve(__dirname,'../../..')}},test:{include:['tests/reviews/b5-financial/*.db.test.ts'],maxWorkers:1,minWorkers:1,hookTimeout:240000,testTimeout:60000}});
