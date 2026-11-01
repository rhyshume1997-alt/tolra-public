"""
A8: the ENGINE half of the trusted-caller + tenant-isolation proof (ChatGPT's condition for activating the costing engine). The app
half is tests/unit/costing-proxy.test.ts (its header lists E1 to E5, which this file proves against the real engine and a real
PostgreSQL database, no mocks):

  E1 token-only trust: every /api/* route answers 401 with no, a wrong, an empty or a differently-cased token and with the token in
     the wrong header; the comparison is constant-time (hmac.compare_digest); the engine refuses to start with the token unset or empty
     unless COSTING_ALLOW_NO_TOKEN=true; /docs, /redoc and /openapi.json are off; the only routes outside /api/ are / and /health,
     and neither returns any company's data.
  E2 organisation id ONLY from X-Org-Id: missing -> 422, not a UUID -> 400; an org id in the query string, the body, a cookie or
     another header is ignored; every list, lookup by id, calculation and write is filtered by it; a part can't be linked to another
     company's material or machine.
  E3 two-company isolation: companies A and B with the SAME part numbers, material and machine names; as A every list shows only A's
     rows; B's part, material, machine, customer and quote ids answer 404 to A exactly as an id that does not exist (same status, same
     body); no response to A carries any of B's names, rates or ids.
  E4 no cross-organisation cache: A then B calculating the same part number and quantity get their own prices; the engine code has no
     lru_cache / cache / module-level result store; no response carries a Cache-Control a shared cache could reuse.
  E5 errors and logs: an unexpected error answers a bare 500 "Internal Server Error" (no stack trace, SQL, connection string or token);
     the engine writes no log line holding the token or the org id. (pip-audit runs as its own CI step.)

Usage: python tests/trusted_caller_proof.py <engine dir> <DATABASE_URL of an EMPTY database>
Requires httpx (for TestClient). Prints PASS/FAIL per check and exits non-zero on any FAIL.
"""
import io
import json
import logging
import os
import subprocess
import sys

ENGINE_DIR = os.path.abspath(sys.argv[1])
DATABASE_URL = sys.argv[2]
TOKEN = "proof-token-7f3a9c"
ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f" ({detail})" if detail and not ok else ""))


# ---- E1 (start-up): fails closed. Each import in its own interpreter, since app.main reads the token when imported. ------------------
def start(env_extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("COSTING_")}
    env.update({"DATABASE_URL": DATABASE_URL, **env_extra})
    return subprocess.run([sys.executable, "-c", "import app.main"], cwd=ENGINE_DIR, env=env, capture_output=True, text=True)


r = start({})
check("E1 start-up refused with COSTING_ENGINE_TOKEN unset", r.returncode != 0 and "COSTING_ENGINE_TOKEN is required" in r.stderr, r.stderr[-200:])
r = start({"COSTING_ENGINE_TOKEN": ""})
check("E1 start-up refused with COSTING_ENGINE_TOKEN empty", r.returncode != 0 and "COSTING_ENGINE_TOKEN is required" in r.stderr, r.stderr[-200:])
r = start({"COSTING_ENGINE_TOKEN": "", "COSTING_ALLOW_NO_TOKEN": "yes"})
check("E1 only the exact value 'true' allows no token (COSTING_ALLOW_NO_TOKEN=yes still refused)", r.returncode != 0, r.stderr[-200:])
r = start({"COSTING_ENGINE_TOKEN": TOKEN})
check("E1 starts with a token", r.returncode == 0, r.stderr[-200:])

# ---- the app, as it runs in production (token set, docs off) ----------------------------------------------------------------------
sys.path.insert(0, ENGINE_DIR)
for k in [k for k in os.environ if k.startswith("COSTING_")]:
    del os.environ[k]
os.environ["COSTING_ENGINE_TOKEN"] = TOKEN
os.environ["DATABASE_URL"] = DATABASE_URL

log_buffer = io.StringIO()
log_handler = logging.StreamHandler(log_buffer)
log_handler.setFormatter(logging.Formatter("%(name)s|%(message)s"))
logging.getLogger().addHandler(log_handler)
logging.getLogger().setLevel(logging.DEBUG)

from fastapi.testclient import TestClient  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from app.main import app  # noqa: E402
import app.main as engine_main  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app import models  # noqa: E402

c = TestClient(app, raise_server_exceptions=False)
H = lambda org: {"Authorization": f"Bearer {TOKEN}", "X-Org-Id": org}  # noqa: E731

# Two companies built through the API itself: the same part number, material and machine names, different rates.
def build(org, rate, material_cost, customer):
    mat = c.post("/api/materials", headers=H(org), json={"name": "Aluminium 6082", "cost_per_lb": material_cost}).json()
    mach = c.post("/api/machines", headers=H(org), json={"name": "Haas VF2", "machine_rate_per_hr": rate, "labor_rate_per_hr": rate / 2}).json()
    cust = c.post("/api/customers", headers=H(org), json={"name": customer}).json()
    part = c.post("/api/parts", headers=H(org), json={"part_number": "P-100", "description": f"Bracket {customer}", "material_id": mat["id"],
                  "stock_weight_lb": 2.0, "operations": [{"machine_id": mach["id"], "name": "Mill", "setup_time_hr": 1.0, "cycle_time_hr": 0.5}]}).json()
    quote = c.post("/api/quotes", headers=H(org), json={"customer_id": cust["id"], "items": [{"part_id": part["id"], "quantity": 10}]})
    return {"material": mat, "machine": mach, "customer": cust, "part": part, "quote": quote.json() if quote.status_code == 200 else None, "quote_status": quote.status_code}


A = build(ORG_A, 85.0, 3.25, "Alpha Customer Ltd")
B = build(ORG_B, 137.0, 9.75, "Beta Secret Holdings")
check("setup: both companies built through the API", all(isinstance(x["part"], dict) and "id" in x["part"] for x in (A, B)) and A["quote_status"] == 200 and B["quote_status"] == 200,
      json.dumps({"A": A["part"], "B": B["part"]})[:300])

# ---- E1: token-only trust on every /api route ---------------------------------------------------------------------------------------
# Every route the app serves, from its own schema (FastAPI wraps included routers, so app.routes alone does not list them), and no
# route is left out of that schema.
schema_paths = app.openapi()["paths"]
api_routes = [(path, sorted(m.upper() for m in ops)) for path, ops in schema_paths.items() if path.startswith("/api/")]
included = [r for r in app.routes if hasattr(r, "original_router")]
hidden = [getattr(x, "path", "?") for ir in included for x in ir.original_router.routes if not getattr(x, "include_in_schema", True)]
hidden += [r.path for r in app.routes if isinstance(r, APIRoute) and not r.include_in_schema]
check("E1 every route is in the app's schema (none hidden from this enumeration)", not hidden and len(api_routes) >= 13, str(hidden) + f" {len(api_routes)} api paths")
other_routes = sorted(path for path in schema_paths if not path.startswith("/api/"))
check("E1 the only routes outside /api/ are / and /health", other_routes == ["/", "/health"], str(other_routes))
check("E1 / and /health carry no company data", c.get("/").json() == {"service": "CNC Quoting System API", "version": "1.0.0"}
      and c.get("/health").json() == {"status": "healthy", "service": "cnc-quoting-api"})


def concrete(path):
    return path.replace("{part_id}", str(A["part"]["id"])).replace("{operation_id}", "1").replace("{material_id}", str(A["material"]["id"])) \
        .replace("{machine_id}", str(A["machine"]["id"])).replace("{customer_id}", str(A["customer"]["id"])).replace("{quote_id}", "1")


bad_auth = {
    "no Authorization": {"X-Org-Id": ORG_A},
    "wrong token": {"Authorization": "Bearer wrong", "X-Org-Id": ORG_A},
    "empty bearer": {"Authorization": "Bearer ", "X-Org-Id": ORG_A},
    "token without Bearer": {"Authorization": TOKEN, "X-Org-Id": ORG_A},
    "lower-case bearer": {"Authorization": f"bearer {TOKEN}", "X-Org-Id": ORG_A},
    "token with a trailing space": {"Authorization": f"Bearer {TOKEN} ", "X-Org-Id": ORG_A},
    "token in X-Api-Key": {"X-Api-Key": TOKEN, "X-Org-Id": ORG_A},
    "token in the query": {"X-Org-Id": ORG_A},
}
leaks = []
for path, methods in api_routes:
    for method in methods:
        for label, headers in bad_auth.items():
            url = concrete(path) + (f"?token={TOKEN}&access_token={TOKEN}" if label == "token in the query" else "")
            resp = c.request(method, url, headers=headers, json={})
            if resp.status_code != 401 or resp.json() != {"detail": "Unauthorized"}:
                leaks.append(f"{method} {path} [{label}] -> {resp.status_code}")
check(f"E1 every /api route x method ({sum(len(m) for _, m in api_routes)}) refuses 8 kinds of bad credentials with 401", not leaks, "; ".join(leaks[:5]))
paths_variants = ["/api/parts/", "/api//parts", "/api/parts?x=1", "/api/quotes/calculate-detailed/"]
check("E1 path variants (trailing slash, double slash) are 401 without the token, never a redirect or data",
      all(c.get(p, headers={"X-Org-Id": ORG_A}, follow_redirects=False).status_code == 401 for p in paths_variants))
src = open(os.path.join(ENGINE_DIR, "app", "main.py"), encoding="utf-8").read()
check("E1 the token comparison is constant-time (hmac.compare_digest over the full header)", "hmac.compare_digest(supplied, ENGINE_TOKEN_BYTES)" in src)
check("E1 /docs, /redoc and /openapi.json are off", all(c.get(p).status_code == 404 for p in ["/docs", "/redoc", "/openapi.json"]))

# ---- E2: organisation id only from X-Org-Id -----------------------------------------------------------------------------------------
check("E2 no X-Org-Id -> 422", c.get("/api/parts", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 422)
check("E2 X-Org-Id not a UUID -> 400 (incl. empty, SQL, two ids)",
      all(c.get("/api/parts", headers={"Authorization": f"Bearer {TOKEN}", "X-Org-Id": v}).status_code == 400
          for v in ["org-a", "", "' OR 1=1 --", f"{ORG_A},{ORG_B}", "%"]))
smuggle = c.get(f"/api/parts?organization_id={ORG_B}&org_id={ORG_B}&x-org-id={ORG_B}",
                headers={**H(ORG_A), "X-Organization-Id": ORG_B, "Organization-Id": ORG_B, "Cookie": f"org_id={ORG_B}"})
check("E2 an org id in the query, another header or a cookie is ignored (A still sees only A)",
      smuggle.status_code == 200 and [p["id"] for p in smuggle.json()] == [A["part"]["id"]])
body_org = c.post("/api/quotes/calculate-detailed", headers=H(ORG_A), json={"part_id": B["part"]["id"], "quantity": 1, "margin_pct": 0.2, "organization_id": ORG_B})
check("E2 an org id in the body is ignored (B's part through A's header is 404)", body_org.status_code == 404)
made = c.post("/api/customers", headers=H(ORG_A), json={"name": "Made by A", "organization_id": ORG_B})
check("E2 a write lands in the header's company whatever the body says",
      made.status_code == 200 and any(x["name"] == "Made by A" for x in c.get("/api/customers", headers=H(ORG_A)).json())
      and not any(x["name"] == "Made by A" for x in c.get("/api/customers", headers=H(ORG_B)).json()))
db = SessionLocal()
check("E2 every stored row is in the company that made it (none blank, none crossed)",
      all(row.organization_id in (ORG_A, ORG_B) for model in (models.Customer, models.Material, models.Machine, models.Part, models.Quote) for row in db.query(model).all())
      and db.query(models.Part).filter(models.Part.organization_id == ORG_A).count() == 1)
db.close()
cross_material = c.post("/api/parts", headers=H(ORG_A), json={"part_number": "P-X1", "material_id": B["material"]["id"], "operations": []})
cross_machine = c.post("/api/parts", headers=H(ORG_A), json={"part_number": "P-X2", "material_id": A["material"]["id"],
                       "operations": [{"machine_id": B["machine"]["id"], "name": "Mill"}]})
retarget = c.put(f"/api/parts/{A['part']['id']}", headers=H(ORG_A), json={"material_id": B["material"]["id"]})
op_id = A["part"]["operations"][0]["id"]
cross_op = c.put(f"/api/parts/{A['part']['id']}/operations/{op_id}", headers=H(ORG_A), json={"machine_id": B["machine"]["id"], "name": "Mill"})
cross_quote = c.post("/api/quotes", headers=H(ORG_A), json={"customer_id": B["customer"]["id"], "items": [{"part_id": A["part"]["id"], "quantity": 1}]})
cross_quote_part = c.post("/api/quotes", headers=H(ORG_A), json={"customer_id": A["customer"]["id"], "items": [{"part_id": B["part"]["id"], "quantity": 1}]})
check("E2 A can't link B's material or machine to a part, nor B's customer or part to a quote (all refused 4xx)",
      all(400 <= x.status_code < 500 for x in (cross_material, cross_machine, retarget, cross_op, cross_quote, cross_quote_part)),
      str([x.status_code for x in (cross_material, cross_machine, retarget, cross_op, cross_quote, cross_quote_part)]))

# ---- E3: two-company isolation -----------------------------------------------------------------------------------------------------
lists = {p: c.get(p, headers=H(ORG_A)).json() for p in ["/api/parts", "/api/materials", "/api/machines", "/api/customers", "/api/quotes"]}
check("E3 as A, every list holds only A's ids",
      [x["id"] for x in lists["/api/parts"]] == [A["part"]["id"]] and [x["id"] for x in lists["/api/materials"]] == [A["material"]["id"]]
      and [x["id"] for x in lists["/api/machines"]] == [A["machine"]["id"]] and B["customer"]["id"] not in [x["id"] for x in lists["/api/customers"]]
      and [x["id"] for x in lists["/api/quotes"]] == [A["quote"]["id"]])
missing_id = 987654
probes = [("GET", "/api/parts/{}", B["part"]["id"]), ("GET", "/api/materials/{}", B["material"]["id"]), ("GET", "/api/machines/{}", B["machine"]["id"]),
          ("GET", "/api/customers/{}", B["customer"]["id"]), ("GET", "/api/quotes/{}", B["quote"]["id"])]
same = []
for method, path, b_id in probes:
    theirs = c.request(method, path.format(b_id), headers=H(ORG_A))
    nobody = c.request(method, path.format(missing_id), headers=H(ORG_A))
    same.append(theirs.status_code == 404 and (theirs.status_code, theirs.text) == (nobody.status_code, nobody.text))
for route in ("/api/quotes/calculate", "/api/quotes/calculate-detailed"):
    theirs = c.post(route, headers=H(ORG_A), json={"part_id": B["part"]["id"], "quantity": 5, "margin_pct": 0.2})
    nobody = c.post(route, headers=H(ORG_A), json={"part_id": missing_id, "quantity": 5, "margin_pct": 0.2})
    same.append(theirs.status_code == 404 and theirs.text == nobody.text)
theirs = c.put(f"/api/parts/{B['part']['id']}", headers=H(ORG_A), json={"description": "hijack"})
nobody = c.put(f"/api/parts/{missing_id}", headers=H(ORG_A), json={"description": "hijack"})
same.append(theirs.status_code == 404 and theirs.text == nobody.text)
check("E3 B's part / material / machine / customer / quote ids, calculations and an update answer A exactly as an id that does not exist (404, same body)", all(same), str(same))
check("E3 B's part is unchanged by A's attempt", c.get(f"/api/parts/{B['part']['id']}", headers=H(ORG_B)).json()["description"] == "Bracket Beta Secret Holdings")
a_text = json.dumps(lists) + "".join(c.post(r, headers=H(ORG_A), json={"part_id": A["part"]["id"], "quantity": 5, "margin_pct": 0.2}).text
                                    for r in ("/api/quotes/calculate", "/api/quotes/calculate-detailed"))
check("E3 nothing A receives names or prices B (Beta Secret Holdings, 137, 9.75, B's ids)",
      "Beta Secret" not in a_text and "137" not in a_text and "9.75" not in a_text and ORG_B not in a_text)

# ---- E4: no cross-organisation cache -----------------------------------------------------------------------------------------------
pa = c.post("/api/quotes/calculate-detailed", headers=H(ORG_A), json={"part_id": A["part"]["id"], "quantity": 10, "margin_pct": 0.2})
pb = c.post("/api/quotes/calculate-detailed", headers=H(ORG_B), json={"part_id": B["part"]["id"], "quantity": 10, "margin_pct": 0.2})
pa2 = c.post("/api/quotes/calculate-detailed", headers=H(ORG_A), json={"part_id": A["part"]["id"], "quantity": 10, "margin_pct": 0.2})
check("E4 same part number and quantity: A and B each get their own price, and A's again after B's", pa.status_code == pb.status_code == 200
      and pa.json() == pa2.json() and pa.json() != pb.json() and pa.json()["part_info"]["description"] == "Bracket Alpha Customer Ltd")
code = "".join(open(os.path.join(dp, f), encoding="utf-8").read() for dp, _, fs in os.walk(os.path.join(ENGINE_DIR, "app")) for f in fs if f.endswith(".py"))
check("E4 no cache in the engine code (lru_cache, functools.cache, cachetools, redis, a module-level result dict)",
      not any(word in code for word in ("lru_cache", "functools.cache", "@cache", "cachetools", "redis", "_CACHE", "_cache")))
heads = [x.headers.get("cache-control", "") for x in (pa, pb, smuggle)]
check("E4 no response says a shared cache may keep it (no public / s-maxage Cache-Control)", not any(("public" in h or "s-maxage" in h) for h in heads), str(heads))

# ---- E5: errors and logs -------------------------------------------------------------------------------------------------------
import app.routers.quotes as quotes_router  # noqa: E402
real = quotes_router.calc_detailed_quote
def boom(**_kwargs):
    raise RuntimeError(f"secret {TOKEN} {DATABASE_URL} SELECT * FROM parts")
quotes_router.calc_detailed_quote = boom
err = c.post("/api/quotes/calculate-detailed", headers=H(ORG_A), json={"part_id": A["part"]["id"], "quantity": 1, "margin_pct": 0.2})
quotes_router.calc_detailed_quote = real
check("E5 an unexpected error is a bare 500 'Internal Server Error' (no trace, SQL, connection string or token)",
      err.status_code == 500 and err.text == "Internal Server Error", err.text[:200])
logging.getLogger().removeHandler(log_handler)
logged = log_buffer.getvalue()
# The forced error above is logged by the server with its traceback (that is the operator's log, holding the message we planted):
# leave that block out and check every other line.
# httpx / httpcore lines are the TEST client's own (it logs the URLs this proof sends, which name both companies), not the engine's.
other_lines = [line for line in logged.splitlines() if not line.startswith(("httpx|", "httpcore")) and "secret" not in line and "RuntimeError" not in line and "Traceback" not in line and not line.startswith("  ")]
check("E5 no other log line holds the token or an org id", not any(TOKEN in line or ORG_A in line or ORG_B in line for line in other_lines))
check("E5 the module keeps only the token's bytes for comparison (never echoed in a response)", TOKEN not in a_text and TOKEN not in err.text and engine_main.ENGINE_TOKEN_BYTES == f"Bearer {TOKEN}".encode())

failed = [n for n, ok in results if not ok]
print(f"TOTAL {len(results) - len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)
