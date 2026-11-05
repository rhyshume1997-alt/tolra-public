import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/xero-picker-adversarial/*.unit.test.ts'],maxWorkers:1,minWorkers:1}});
