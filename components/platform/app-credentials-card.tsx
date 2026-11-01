"use client";

import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDate } from "@/lib/dates";
import { APP_TEST_NOTE, XERO_TEST_CONNECTION_NOTE, appTestMessage, isAppTestOutcome } from "@/lib/integrations/app-test-messages";

type ProviderRow = {
  provider: "xero" | "microsoft";
  name: string;
  stored: { clientId: string; secretLast4: string; updatedAt: string } | null;
  fromEnvironment: boolean;
  redirectUris: string[];
  scopes: Array<{ scope: string; text: string | null }>;
};
type Answer = { db107: boolean; siteUrlSet: boolean; providers: ProviderRow[] };

/**
 * Platform > App connections (E2/E7, migration 107): the platform owner enters Tolra's app details at Xero and at Microsoft ONCE; each
 * company then just clicks Connect on Admin > Integrations. Shows the client id and the secret's last four only, and the exact redirect
 * URI(s) to paste at the provider. Hidden for anyone who is not the platform owner (the route answers 403).
 */
export function AppCredentialsCard() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [hidden, setHidden] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [forms, setForms] = useState<Record<string, { clientId: string; clientSecret: string }>>({});
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ provider: "xero" | "microsoft"; ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/integrations/app-credentials", { credentials: "same-origin" }).catch(() => null);
    if (!res || res.status === 401 || res.status === 403) return setHidden(true);
    const body = (await res.json().catch(() => null)) as (Answer & { error?: string }) | null;
    if (!res.ok || !body) return setMessage({ ok: false, text: body?.error ?? "Couldn't load the app details." });
    setAnswer(body);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The provider sends the owner back to /platform?app_test=<provider>&result=<outcome> after the test sign-in (the callback stores nothing).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("app_test");
    const result = params.get("result");
    if ((provider !== "xero" && provider !== "microsoft") || !isAppTestOutcome(result)) return;
    setTestResult({ provider, ok: result === "ok", text: appTestMessage(provider, result) });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ ok: true, text: "Copied." });
    } catch {
      setMessage({ ok: false, text: "Couldn't copy: select the text and copy it." });
    }
  }

  async function runTest(provider: ProviderRow) {
    setBusy(true);
    setMessage(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/integrations/app-credentials/test", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.provider }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || typeof body.url !== "string") return setTestResult({ provider: provider.provider, ok: false, text: body.error ?? "Couldn't start the test. Try again." });
      window.location.assign(body.url);
    } finally {
      setBusy(false);
    }
  }

  async function save(provider: ProviderRow) {
    const form = forms[provider.provider] ?? { clientId: provider.stored?.clientId ?? "", clientSecret: "" };
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/integrations/app-credentials", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.provider, clientId: form.clientId, clientSecret: form.clientSecret }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setMessage({ ok: false, text: body.error ?? "Couldn't save the app details." });
      setMessage({ ok: true, text: `${provider.name} app details saved. Each company can now click Connect.` });
      setForms((f) => ({ ...f, [provider.provider]: { clientId: form.clientId, clientSecret: "" } }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: ProviderRow) {
    if (!window.confirm(`Remove the ${provider.name} app details? Companies can't connect (and connected ones can't renew their sign-in) until they are entered again.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/integrations/app-credentials?provider=${provider.provider}`, { method: "DELETE", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setMessage({ ok: false, text: body.error ?? "Couldn't remove the app details." });
      setMessage({ ok: true, text: `${provider.name} app details removed.` });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  return (
    <section className="mt-10" data-testid="app-credentials">
      <h2 className="text-xl font-semibold text-slate-950">App connections</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-500">
        Enter Tolra&apos;s app details from Xero and from Microsoft once. Each company then connects with one click on Admin &gt; Integrations. The secret is
        encrypted on the server and never shown again: only its last four characters.
      </p>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-4 rounded-lg border bg-white px-4 py-3 text-sm ${message.ok ? "border-emerald-200 text-emerald-800" : "border-red-200 text-red-700"}`}>{message.text}</p> : null}
      {answer && !answer.db107 ? <p className="mt-4 text-sm text-slate-500">Not available until database update 107 is applied. Until then the server&apos;s environment settings are used.</p> : null}
      {answer && !answer.siteUrlSet ? <p className="mt-4 text-sm text-amber-800">The server&apos;s site address (NEXT_PUBLIC_SITE_URL) is not set, so the redirect URI can&apos;t be shown or used yet.</p> : null}
      <div className="mt-4 grid gap-4">
        {(answer?.providers ?? []).map((p) => {
          const form = forms[p.provider] ?? { clientId: p.stored?.clientId ?? "", clientSecret: "" };
          const set = (patch: Partial<typeof form>) => setForms((f) => ({ ...f, [p.provider]: { ...form, ...patch } }));
          return (
            <Card key={p.provider} className="border-slate-200" data-provider={p.provider}>
              <CardContent className="grid gap-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-ink"><KeyRound className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-950">{p.name}</p>
                    <p className="text-xs text-slate-500" data-testid={`app-credentials-${p.provider}-state`}>
                      {p.stored ? <>Saved: client id <strong>{p.stored.clientId}</strong>, secret ending <strong>{p.stored.secretLast4}</strong>, {fmtDate(p.stored.updatedAt)}</>
                        : p.fromEnvironment ? "Using the server's environment settings." : "Not set up yet."}
                    </p>
                  </div>
                </div>
                {p.redirectUris.length ? (
                  <div className="text-xs text-slate-600" data-testid={`app-credentials-${p.provider}-redirects`}>
                    Redirect URI{p.redirectUris.length > 1 ? "s" : ""} to paste at {p.name}:
                    {p.redirectUris.map((u) => (
                      <div key={u} className="mt-1 flex items-center gap-2">
                        <code className="block min-w-0 flex-1 break-all rounded bg-slate-100 px-2 py-1">{u}</code>
                        <Button type="button" variant="outline" size="sm" onClick={() => void copy(u)} aria-label={`Copy ${u}`}>Copy</Button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {p.scopes?.length ? (
                  <div className="text-xs text-slate-600" data-testid={`app-credentials-${p.provider}-scopes`}>
                    Scopes to tick at {p.name}:
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {p.scopes.map((s) => <li key={s.scope}><span className="font-mono">{s.scope}</span>{s.text ? <> ({s.text})</> : null}</li>)}
                    </ul>
                  </div>
                ) : null}
                <div className="grid gap-1">
                  <div>
                    <Button type="button" variant="outline" disabled={busy || !answer?.siteUrlSet || (!p.stored && !p.fromEnvironment)} className="min-h-11" onClick={() => void runTest(p)}>Test connection</Button>
                  </div>
                  {testResult?.provider === p.provider ? (
                    <p role={testResult.ok ? "status" : "alert"} className={`text-sm ${testResult.ok ? "text-emerald-700" : "text-red-700"}`} data-testid={`app-credentials-${p.provider}-test-result`}>{testResult.text}</p>
                  ) : null}
                  {p.stored || p.fromEnvironment ? <p className="text-xs text-slate-500">{APP_TEST_NOTE}</p> : null}
                  {p.provider === "xero" ? <p className="text-xs text-slate-500" data-testid="app-credentials-xero-test-note">{XERO_TEST_CONNECTION_NOTE}</p> : null}
                </div>
                {answer?.db107 ? (
                  <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void save(p); }}>
                    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                      Client id
                      <Input aria-label={`${p.name} client id`} value={form.clientId} maxLength={200} onChange={(e) => set({ clientId: e.target.value })} className="h-11" autoComplete="off" spellCheck={false} />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                      Client secret {p.stored ? <span className="font-normal text-slate-500">(leave empty to keep the saved one)</span> : null}
                      <Input aria-label={`${p.name} client secret`} type="password" value={form.clientSecret} maxLength={1000} onChange={(e) => set({ clientSecret: e.target.value })} className="h-11" autoComplete="new-password" spellCheck={false} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={busy || !form.clientId.trim() || (!p.stored && !form.clientSecret.trim())} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">Save</Button>
                      {p.stored ? <Button type="button" variant="outline" disabled={busy} className="min-h-11" onClick={() => void remove(p)}>Remove</Button> : null}
                    </div>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
