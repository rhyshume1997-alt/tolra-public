import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':path.resolve(process.env.XERO_INVITE_SOURCE_ROOT??'.')}},test:{include:['tests/reviews/xero-invite-adversarial/*.unit.test.ts'],maxWorkers:1,minWorkers:1}});
