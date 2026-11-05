import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/db/chase-steps-138.test.ts','tests/db/admin-mfa-onboarding.test.ts','tests/db/email-templates-106.test.ts'],setupFiles:['tests/reviews/night-email-auth/db.setup.ts'],fileParallelism:false,maxWorkers:1,minWorkers:1,testTimeout:30000,hookTimeout:180000}});
