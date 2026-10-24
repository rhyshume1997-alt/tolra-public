#!/bin/sh
set -e

echo "Starting CNC costing engine..."

# Upgrade legacy databases (adds organization_id columns), then create any missing tables.
# Demo data is seeded only when COSTING_SEED_DEMO_DATA=true AND COSTING_SEED_ORG_ID is a UUID.
python -c "
import os, uuid
from app.db import Base, engine, SessionLocal, migrate_legacy_schema
from app.seed import seed_database

print('Migrating legacy schema...')
migrate_legacy_schema()
print('Creating database tables...')
Base.metadata.create_all(bind=engine)

if os.getenv('COSTING_SEED_DEMO_DATA', 'false').lower() == 'true':
    org = os.getenv('COSTING_SEED_ORG_ID', '').strip()
    if not org:
        print('COSTING_SEED_DEMO_DATA=true but COSTING_SEED_ORG_ID is unset; skipping seed.')
    else:
        print('Seeding database...')
        db = SessionLocal()
        try:
            seed_database(db, str(uuid.UUID(org)))
        finally:
            db.close()
"

# Start FastAPI server (set UVICORN_RELOAD=true for local development)
if [ "${UVICORN_RELOAD:-false}" = "true" ]; then
  exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --reload
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
