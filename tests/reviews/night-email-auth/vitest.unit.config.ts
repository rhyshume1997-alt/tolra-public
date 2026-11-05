import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/night-email-auth/*.unit.test.ts','tests/unit/b4-*.test.ts','tests/unit/r1-*.test.ts','tests/unit/f3-resend-test-send.test.ts','tests/unit/company-email.test.ts','tests/unit/email-send-route.test.ts','tests/unit/email-ready-workflows.test.ts','tests/unit/resend-status.test.ts','tests/unit/chase-*.test.ts'],maxWorkers:2,minWorkers:1}});
