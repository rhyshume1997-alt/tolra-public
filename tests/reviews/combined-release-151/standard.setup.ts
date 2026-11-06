/** SQL-only disposable PostgreSQL fixture. This does not claim hosted Auth/PostgREST/browser proof. */
import {beforeAll,afterAll} from 'vitest';
import {db,start,stop} from '../review437/fixture';
process.env.TEST_SUPABASE_URL='http://127.0.0.1:54321';
process.env.TEST_SUPABASE_ANON_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiJ9.synthetic';
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic';
beforeAll(async()=>{await start();const name=(await db.query('select current_database() as name')).rows[0].name;process.env.TEST_DATABASE_URL=`postgresql://xero_test@127.0.0.1:54849/${name}`;await db.query('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key)');});
afterAll(stop);
