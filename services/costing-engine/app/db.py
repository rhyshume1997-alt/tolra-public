from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
import os

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg2://postgres:postgres@localhost:5432/cncq")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


TENANT_TABLES = ("customers", "materials", "machines", "parts", "quotes")


def migrate_legacy_schema():
    """Bring a pre-tenancy database up to date. Idempotent; run before Base.metadata.create_all().

    Existing rows get organization_id '' and are invisible to every tenant until reassigned, e.g.
    UPDATE parts SET organization_id = '<org uuid>' WHERE organization_id = '';
    """
    if engine.dialect.name != "postgresql":
        return
    existing = set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        for table in TENANT_TABLES:
            if table not in existing:
                continue  # fresh database: create_all() builds it with the column already in place
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS organization_id varchar(36) NOT NULL DEFAULT ''"))
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table}_organization_id ON {table} (organization_id)"))
        if "parts" in existing:
            conn.execute(text("ALTER TABLE parts DROP CONSTRAINT IF EXISTS parts_part_number_key"))
            conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_org_part_number ON parts (organization_id, part_number)"))
