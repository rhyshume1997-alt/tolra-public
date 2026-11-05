import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/night-151-package/*.db.test.ts'],setupFiles:['tests/reviews/night-151-package/db.setup.ts'],maxWorkers:1,minWorkers:1,testTimeout:30000,hookTimeout:180000}});
