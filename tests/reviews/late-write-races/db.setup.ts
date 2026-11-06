/** SQL-only nonce fixture. Auth/Storage tables are stand-ins, never hosted Auth/browser proof. */
import {beforeAll,afterAll} from 'vitest';
import {db,start,stop} from '../pending-oauth/fixture';
process.env.TEST_SUPABASE_URL='http://127.0.0.1:54321';
process.env.TEST_SUPABASE_ANON_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiJ9.synthetic';
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic';
beforeAll(async()=>{await start();const name=(await db.query('select current_database() as n')).rows[0].n;process.env.TEST_DATABASE_URL=`postgresql://xero_test@127.0.0.1:54849/${name}`;await db.query('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key)');await db.query('ALTER TABLE auth.sessions DROP CONSTRAINT sessions_user_id_fkey, ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE');});
afterAll(stop);
