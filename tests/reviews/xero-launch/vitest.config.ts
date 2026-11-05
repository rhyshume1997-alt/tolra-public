import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/reviews/xero-launch/*.test.ts'],maxWorkers:1,minWorkers:1,hookTimeout:180000,testTimeout:30000}});
