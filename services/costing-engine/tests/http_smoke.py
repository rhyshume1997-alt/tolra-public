"""
HTTP smoke for the costing engine (audit B9: SEC11). Seeds one organisation into an empty database, then exercises
auth, tenancy, listing and cost calculations through the real app. Writes every response to a JSON file so two
dependency sets can be compared byte for byte (used to validate the FastAPI/Starlette upgrade).

Usage: python tests/http_smoke.py <engine dir> <DATABASE_URL of an EMPTY database> <output.json>
Requires httpx (for TestClient). Fails (non-zero) if any expectation below isn't met.
"""
import json, os, sys
sys.path.insert(0, sys.argv[1])
os.environ["COSTING_ENGINE_TOKEN"] = "smoke-token"
os.environ["DATABASE_URL"] = sys.argv[2]
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.seed import seed_database

db = SessionLocal(); seed_database(db, "11111111-1111-4111-8111-111111111111"); db.close()
c = TestClient(app)
auth = {"Authorization": "Bearer smoke-token", "X-Org-Id": "11111111-1111-4111-8111-111111111111"}
out = []
def rec(label, r):
    try: body = r.json()
    except Exception: body = r.text
    out.append({"label": label, "status": r.status_code, "body": body})
rec("health", c.get("/health"))
rec("root", c.get("/"))
rec("no token", c.get("/api/parts"))
rec("bad token", c.get("/api/parts", headers={"Authorization": "Bearer nope", "X-Org-Id": "11111111-1111-4111-8111-111111111111"}))
rec("no org header", c.get("/api/parts", headers={"Authorization": "Bearer smoke-token"}))
rec("bad org header", c.get("/api/parts", headers={"Authorization": "Bearer smoke-token", "X-Org-Id": "org-a"}))
for path in ["/api/parts", "/api/machines", "/api/materials", "/api/customers", "/api/quotes"]:
    rec(path, c.get(path, headers=auth))
rec("other org parts", c.get("/api/parts", headers={**auth, "X-Org-Id": "22222222-2222-4222-8222-222222222222"}))
parts = c.get("/api/parts", headers=auth).json()
if not isinstance(parts, list): print("PARTS", parts, file=sys.stderr); parts = []
for p in parts[:6]:
    for qty in (1, 10, 250):
        rec(f"calc {p['id']} x{qty}", c.post("/api/quotes/calculate", headers=auth, json={"part_id": p["id"], "quantity": qty, "margin_pct": 0.25}))
        rec(f"detail {p['id']} x{qty}", c.post("/api/quotes/calculate-detailed", headers=auth, json={"part_id": p["id"], "quantity": qty, "margin_pct": 0.25}))
rec("calc missing part", c.post("/api/quotes/calculate", headers=auth, json={"part_id": 999999, "quantity": 1, "margin_pct": 0.25}))
rec("calc invalid body", c.post("/api/quotes/calculate", headers=auth, json={"part_id": "x"}))
rec("docs hidden", c.get("/docs"))
open(sys.argv[3], "w").write(json.dumps(out, sort_keys=True, indent=1, default=str))

status = {x["label"]: x["status"] for x in out}
expected = {"health": 200, "no token": 401, "bad token": 401, "no org header": 422, "bad org header": 400,
            "/api/parts": 200, "calc missing part": 404, "calc invalid body": 422, "docs hidden": 404}
problems = [f"{k}: {status.get(k)} != {v}" for k, v in expected.items() if status.get(k) != v]
calcs = [x for x in out if x["label"].startswith(("calc ", "detail ")) and "missing" not in x["label"] and "invalid" not in x["label"]]
if not calcs or any(x["status"] != 200 for x in calcs):
    problems.append("a calculation failed")
if next(x for x in out if x["label"] == "other org parts")["body"] != []:
    problems.append("another organisation's parts were visible")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"{len(out)} responses checked, {len(calcs)} calculations OK", file=sys.stderr)
