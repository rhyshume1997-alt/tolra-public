#!/usr/bin/env python3
"""Tiny local stand-in for the Auth and Storage version endpoints (tests/scripts/backup-run.test.sh). Localhost only.

  version-stub.py <mode> <port file>      modes: ok | http500 | auth-malformed | storage-malformed | no-version
Binds an ephemeral port on 127.0.0.1 and writes it to <port file>. Requires apikey == $STUB_KEY on both endpoints (401 otherwise).
"""
import http.server, os, sys

mode, portfile = sys.argv[1], sys.argv[2]
KEY = os.environ["STUB_KEY"]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        b = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        if self.headers.get("apikey") != KEY: return self.send(401, '{"message":"bad key"}')
        if mode == "http500": return self.send(500, '{"message":"boom"}')
        if self.path == "/auth/v1/health":
            if mode == "auth-malformed": return self.send(200, "<html>not json</html>", "text/html")
            if mode == "no-version": return self.send(200, '{"name":"GoTrue","description":"x"}')
            return self.send(200, '{"version":"v2.180.0","name":"GoTrue"}')
        if self.path == "/storage/v1/version":
            if self.headers.get("Authorization") != "Bearer " + KEY: return self.send(401, "{}")
            if mode == "storage-malformed": return self.send(200, "<html>oops</html>", "text/html")
            return self.send(200, "1.28.2", "text/plain")
        self.send(404, "{}")

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
