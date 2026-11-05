import path from 'node:path';import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/night-sliq-readonly/*.unit.test.ts','tests/unit/sliq-reconcile*.test.ts'],maxWorkers:2,minWorkers:1}});
