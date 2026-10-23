/**
 * Local stand-ins for outbound providers during browser tests (audit B1). The app server is started with
 * RESEND_BASE_URL pointing here, so any e-mail it "sends" is recorded instead of delivered.
 */
import { createServer, type Server } from "node:http";

export type RecordedEmail = { path: string; body: unknown; at: string; idempotencyKey: string | null };

export async function startMockProviders(port: number) {
  const emails: RecordedEmail[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/__emails") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(emails));
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/emails")) {
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {}
        emails.push({ path: request.url, body, at: new Date().toISOString(), idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? null });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `mock-${emails.length}` }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "mock provider: unknown route" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { emails, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
