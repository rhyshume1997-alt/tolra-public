import {beforeAll,afterAll} from 'vitest';
import {nonce,start,stop} from './fixture';
process.env.TEST_DATABASE_URL=`postgresql://xero_test@127.0.0.1:54849/${nonce}`;
process.env.TEST_SUPABASE_URL='http://127.0.0.1:54321';
process.env.TEST_SUPABASE_ANON_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiJ9.synthetic';
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic';
beforeAll(start);afterAll(stop);
