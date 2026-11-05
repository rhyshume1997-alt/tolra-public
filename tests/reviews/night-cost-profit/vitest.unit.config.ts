import path from 'node:path';
import {defineConfig} from 'vitest/config';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.resolve('.')}},test:{include:['tests/reviews/night-cost-profit/*.unit.test.ts','tests/unit/b5-costing-stale-ui.test.ts','tests/unit/costing-golden.test.ts','tests/unit/costing-engine-parity.test.ts','tests/unit/costing-price-part.test.ts','tests/unit/costing-extra-edge.test.ts','tests/unit/b5-profitability-*.test.ts','tests/unit/job-profitability-actuals.test.ts'],maxWorkers:1,minWorkers:1}});
