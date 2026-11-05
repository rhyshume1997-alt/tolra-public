import {defineConfig} from 'vitest/config';
const root='/workspace/work/xero-candidate-snapshot';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'@':root}},test:{root,include:['tests/unit/*xero*.test.ts','tests/unit/integrations-engine.test.ts'],maxWorkers:2,minWorkers:1}});
