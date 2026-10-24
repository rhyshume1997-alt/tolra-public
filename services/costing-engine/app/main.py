import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .db import Base, engine, migrate_legacy_schema
from .routers import customers, materials, machines, parts, quotes

# Shared secret between Tolra and the engine. The engine refuses to start without it so a missing
# variable can never leave the API open. Local development only: COSTING_ALLOW_NO_TOKEN=true.
ENGINE_TOKEN = os.environ.get("COSTING_ENGINE_TOKEN", "")
ALLOW_NO_TOKEN = os.getenv("COSTING_ALLOW_NO_TOKEN", "").lower() == "true"
if not ENGINE_TOKEN and not ALLOW_NO_TOKEN:
    raise RuntimeError("COSTING_ENGINE_TOKEN is required (set COSTING_ALLOW_NO_TOKEN=true for local development only)")
ENGINE_TOKEN_BYTES = f"Bearer {ENGINE_TOKEN}".encode()

ENABLE_DOCS = os.getenv("COSTING_ENABLE_DOCS", "").lower() == "true"

app = FastAPI(
    title="CNC Quoting System",
    description="Professional CNC machining quoting engine with accurate cost calculation",
    version="1.0.0",
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)

# The engine is called server-to-server by Tolra, so no CORS middleware unless origins are explicitly set.
cors_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
if cors_origins:
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type", "X-Org-Id"],
    )


@app.middleware("http")
async def require_engine_token(request: Request, call_next):
    if ENGINE_TOKEN and request.url.path.startswith("/api/"):
        supplied = request.headers.get("authorization", "").encode("utf-8", "ignore")
        if not hmac.compare_digest(supplied, ENGINE_TOKEN_BYTES):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


# Upgrade legacy databases, then create any missing tables
migrate_legacy_schema()
Base.metadata.create_all(bind=engine)

# Include routers
app.include_router(customers.router)
app.include_router(materials.router)
app.include_router(machines.router)
app.include_router(parts.router)
app.include_router(quotes.router)

@app.get("/")
def root():
    return {"service": "CNC Quoting System API", "version": "1.0.0"}

@app.get("/health")
def health():
    return {"status": "healthy", "service": "cnc-quoting-api"}
