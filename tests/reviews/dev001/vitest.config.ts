import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({resolve:{alias:{'@/lib/job-delivery-note-no-order':path.resolve('tests/reviews/dev001/fixtures/job-delivery-note-no-order.ts'),'@':path.resolve('.')}},esbuild:{jsx:'automatic'},test:{include:['tests/reviews/dev001/*.test.ts'],environment:'jsdom'}});
