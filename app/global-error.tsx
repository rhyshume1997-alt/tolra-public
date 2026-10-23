"use client";

import { useEffect, useState } from "react";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";
import { PRODUCT } from "@/lib/product";
import { reportClientError } from "@/lib/report-client-error";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // A tab still running the previous deploy: reload once to pick up the new build (lib/chunk-reload.ts).
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    console.error(error);
    if (reloadOnceForChunkError(error)) setUpdating(true);
    else reportClientError(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", margin: 0, background: "#f8fafc", color: "#0f172a" }}>
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          {updating ? <p style={{ fontSize: 14, color: "#475569" }}>Loading the latest version...</p> : <>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#475569", marginBottom: 16 }}>{PRODUCT.name} hit an unexpected problem. Try again, and if it keeps happening contact your administrator.</p>
          <button onClick={reset} style={{ background: "#1E3472", color: "#fff", border: 0, borderRadius: 8, padding: "10px 20px", fontSize: 14, cursor: "pointer" }}>Retry</button>
          </>}
        </div>
      </body>
    </html>
  );
}
