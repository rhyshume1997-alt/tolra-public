import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: [
  { find: '@/lib/job-profitability-actuals', replacement: resolve(__dirname, 'fixtures/actuals.ts') },
  { find: '@', replacement: resolve(__dirname, '../../..') },
] }, test: { include: ['tests/reviews/profitability/*.test.ts'], pool: 'forks', maxWorkers: 1, minWorkers: 1 } });
