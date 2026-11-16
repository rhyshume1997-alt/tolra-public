import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({ resolve: { alias: { '@':path.resolve('.') } }, test: { include:['tests/reviews/g27/*.test.ts'], testTimeout:60000, hookTimeout:30000, fileParallelism:false } });
