import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({resolve:{alias:{'@':resolve(__dirname,'../../..')}},test:{include:['tests/reviews/own-key/*.test.ts'],maxWorkers:1,minWorkers:1}});
