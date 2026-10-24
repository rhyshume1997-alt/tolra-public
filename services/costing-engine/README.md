# CNC Costing Engine

FastAPI + PostgreSQL service that prices CNC machined parts: material (with
scrap), machine and labour time per operation, tooling, programming,
inspection, consumables, overhead and margin.

Imported from an upstream project by its author; redistribution rights held by the Tolra owner.
(backend only — Tolra provides the UI). Changes from upstream:

- **Fails closed**: `COSTING_ENGINE_TOKEN` is required at startup; every `/api/*`
  request must send `Authorization: Bearer <token>` (constant-time byte compare).
  `COSTING_ALLOW_NO_TOKEN=true` permits an empty token for local development only.
- **Multi-tenant**: every `/api/*` request must carry `X-Org-Id: <organization uuid>`
  (sent by the Tolra proxy). Customers, materials, machines, parts and quotes
  carry `organization_id`; every query filters on it and every insert sets it.
  Part numbers are unique per organization.
- No CORS middleware (server-to-server) unless `CORS_ORIGINS` is set.
- `/docs`, `/redoc` and `/openapi.json` are off unless `COSTING_ENABLE_DOCS=true`.
- Request models are bounded (`quantity` 1..1,000,000, `margin_pct` 0..5, rates and
  times >= 0, no NaN/inf, string lengths capped).
- Container runs as a non-root user without `--reload` (`UVICORN_RELOAD=true` for dev).
- Demo data is **off** by default: set `COSTING_SEED_DEMO_DATA=true` and
  `COSTING_SEED_ORG_ID=<uuid>` to seed one organization.

## How Tolra uses it

The Quote Builder (`/quotes` → New Quote) has a **Price from costing engine**
panel. It loads parts from the engine, calculates a detailed breakdown for a
quantity and margin, and adds the result as a quote line item.

The browser never calls the engine directly. Requests go through
`app/api/costing/[...path]/route.ts`, which checks the Supabase session
(active admin/office only), allows only `GET parts|materials|machines` and
`POST quotes/calculate-detailed` (body validated, 10 KB cap), and forwards with
the shared token and `X-Org-Id`. Upstream error text is never relayed.

## Running it

```bash
cd services/costing-engine
POSTGRES_PASSWORD=change-me COSTING_ENGINE_TOKEN=change-me docker compose up --build
```

Engine API on http://127.0.0.1:8001 (ports are bound to localhost). Then in
Tolra's `.env.local`:

```
COSTING_ENGINE_URL=http://localhost:8001
COSTING_ENGINE_TOKEN=change-me
```

Without Docker: Python 3.11, `pip install -r requirements.txt`, set
`DATABASE_URL=postgresql+psycopg2://USER:PASS@HOST:5432/cncq` and
`COSTING_ENGINE_TOKEN`, then `sh startup.sh`.

## Upgrading an existing database

There are no migrations framework; `startup.sh` (and `app.main`) run
`migrate_legacy_schema()` before `create_all()`. It adds
`organization_id varchar(36) NOT NULL DEFAULT ''` plus an index to the five tenant
tables, drops the old global `parts_part_number_key` unique constraint and creates
`UNIQUE (organization_id, part_number)`. It is idempotent. A fresh database needs
nothing extra.

Legacy rows get `organization_id = ''` and are invisible to every tenant. To claim
them for one company:

```sql
UPDATE customers SET organization_id = '<org uuid>' WHERE organization_id = '';
-- repeat for materials, machines, parts, quotes
```

## Rates and currency

The engine is currency-agnostic; Tolra displays its numbers as GBP. The
demo seed data uses US-style rates (cost per lb, hourly rates), so replace
materials, machines and parts with your own GBP rates before quoting real
work (via the API at `/docs`).
