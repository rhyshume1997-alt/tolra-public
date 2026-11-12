import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/g33/*.test.ts'],hookTimeout:180000,testTimeout:60000,fileParallelism:false}});
