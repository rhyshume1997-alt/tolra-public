"use client";

import { useState, type FormEvent } from "react";

import { useAiFeatures } from "@/components/ai-features";
import { useAiHelperStatus, type AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { SetupCard } from "@/components/integrations/setup-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ANTHROPIC_KEYS_URL, KEY_SHAPE_MESSAGE, TOLRA_LIMIT_NOTE, type AiProvider, limitRequest, parseLimit, buildAiSetup, effectiveProvider, keyChangeNotice, keyLooksRight, postJson, requestJson, safeMessage, switchRequest,
} from "@/lib/integrations/ai-setup";
import { SHARED_TOLRA_AI_ACTIVE } from "@/lib/ai-helper/shared-ai-deactivation";
import { sendWithCode } from "@/lib/mfa-step-up";

/**
 * Admin > Integrations > AI: guided setup in the shared SetupCard frame.
 *   1. the AI is provided by Anthropic with the company's own key (the Tolra-provided choice is hidden while SHARED_TOLRA_AI_ACTIVE is false);
 *   2. get a key (plain link to the Anthropic Console, opens in a new tab);
 *   3. paste the key (password field) and save it: sent once to /api/ai-helper/key, which encrypts it. It is never shown again, the field is
 *      emptied the moment Save is pressed, and only "saved" and the last four characters come back;
 *   4. "Turn on AI": its own switch, OFF by default. Saving, replacing or removing the key switches AI OFF (the database does it, release 150) and the
 *      card says so: AI has to be turned on again on purpose. Turning it on needs an admin and a fresh
 *      authenticator code (the server asks; the code dialog opens; the same request is sent once more).
 * The server's emergency disables (AI_HELPER_ENABLED, the assistant's flag, Tolra's platform switch) are shown as reasons and cannot be bypassed here.
 */
export function AiSetupCard() {
  const { aiHelper } = useAiFeatures();
  const { status, loaded, allowed, reload } = useAiHelperStatus();
  const { requestCode, codeDialog } = useCodePrompt();
  const serverOn = Boolean(aiHelper);
  return (
    <>
      <AiSetupPanel serverOn={serverOn} loaded={!serverOn || !allowed || loaded} status={serverOn && allowed ? status : null} reload={reload} requestCode={requestCode} />
      {codeDialog}
    </>
  );
}

type Notice = { tone: "ok" | "error"; text: string } | null;

/** The card without its data hooks: everything it needs comes in as props (this is what the tests drive). */
export function AiSetupPanel(props: {
  serverOn: boolean;
  loaded: boolean;
  status: AiHelperStatus | null;
  reload: () => void | Promise<void>;
  requestCode: () => Promise<boolean>;
  fetchFn?: typeof fetch;
}) {
  const { serverOn, loaded, status, reload, requestCode, fetchFn } = props;
  const [picked, setPicked] = useState<AiProvider>("anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"key" | "switch" | "limit" | null>(null);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const provider = effectiveProvider(status, picked);
  const model = buildAiSetup({ serverOn, loaded, status, chosen: provider });
  const canManage = Boolean(status?.can_manage);
  const send = (path: string, body: unknown) => () => postJson(path, body, fetchFn);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (busy || !status) return;
    const value = key.trim();
    setKey(""); // the field is empty from this moment, whatever happens next
    if (!keyLooksRight(value)) {
      setNotice({ tone: "error", text: KEY_SHAPE_MESSAGE });
      return;
    }
    const replacing = status.key_set;
    const wasOn = model.on === true;
    setBusy("key");
    setNotice(null);
    const outcome = await sendWithCode(send("/api/ai-helper/key", { key: value }), requestCode);
    if (outcome.result === "done") {
      await reload();
      setNotice({ tone: "ok", text: keyChangeNotice(replacing ? "replaced" : "saved", wasOn) });
    } else if (outcome.result === "cancelled") {
      setNotice({ tone: "error", text: "Cancelled. Nothing was changed." });
    } else {
      setNotice({ tone: "error", text: safeMessage(outcome.answer.body, "The key could not be saved. Try again.", value) });
    }
    setBusy(null);
  }

  async function saveLimit(event: FormEvent) {
    event.preventDefault();
    if (busy || !status || limitDraft === null) return;
    const parsed = parseLimit(limitDraft);
    if (!parsed.ok) {
      setNotice({ tone: "error", text: parsed.message });
      return;
    }
    const request = limitRequest(status, parsed.pence);
    setBusy("limit");
    setNotice(null);
    const outcome = await sendWithCode(send(request.path, request.body), requestCode);
    if (outcome.result === "done") {
      setLimitDraft(null);
      await reload();
      setNotice({ tone: "ok", text: "Monthly limit saved. Saving the limit does not turn AI on or off." });
    } else if (outcome.result === "cancelled") {
      setNotice({ tone: "error", text: "Cancelled. Nothing was changed." });
    } else {
      setNotice({ tone: "error", text: safeMessage(outcome.answer.body, "The limit could not be saved. Try again.") });
    }
    setBusy(null);
  }

  async function removeKey() {
    if (busy || !status || !status.key_set) return;
    const wasOn = model.on === true;
    setBusy("key");
    setNotice(null);
    const outcome = await sendWithCode(() => requestJson("DELETE", "/api/ai-helper/key", undefined, fetchFn), requestCode);
    if (outcome.result === "done") {
      await reload();
      setNotice({ tone: "ok", text: keyChangeNotice("removed", wasOn) });
    } else if (outcome.result === "cancelled") {
      setNotice({ tone: "error", text: "Cancelled. Nothing was changed." });
    } else {
      setNotice({ tone: "error", text: safeMessage(outcome.answer.body, "The key could not be removed. Try again.") });
    }
    setBusy(null);
  }

  async function changeSwitch(next: boolean) {
    if (busy || !status) return;
    const request = switchRequest(provider, status, next);
    setBusy("switch");
    setNotice(null);
    const outcome = await sendWithCode(send(request.path, request.body), requestCode);
    if (outcome.result === "done") {
      await reload();
      setNotice({ tone: "ok", text: next ? "AI is on." : "AI is off." });
    } else if (outcome.result === "cancelled") {
      setNotice({ tone: "error", text: "Cancelled. Nothing was changed." });
    } else {
      setNotice({ tone: "error", text: safeMessage(outcome.answer.body, "AI could not be changed. Try again.") });
    }
    setBusy(null);
  }

  const showSetup = serverOn && loaded && Boolean(status);
  const pickerLocked = model.on === true || !canManage || busy !== null;
  return (
    <SetupCard
      id="ai"
      title="AI"
      summary="Choose who provides the AI, then turn it on as its own step. It only makes suggestions: a person checks and approves everything."
      connection={model.connection}
      steps={model.steps}
      footnote={model.footnote}
      activation={{
        label: "Turn on AI",
        on: model.on,
        disabledReason: model.disabledReason,
        busy: busy !== null,
        onChange: showSetup && canManage ? (next) => void changeSwitch(next) : undefined,
        help: model.help || undefined,
      }}
    >
      {showSetup ? (
        <>
          <fieldset className="grid gap-2" disabled={pickerLocked} data-testid="ai-provider">
            <legend className="font-medium">Who provides the AI</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="ai-provider" value="anthropic" checked={provider === "anthropic"} onChange={() => setPicked("anthropic")} />
              <span>Anthropic, with your company&apos;s own key</span>
            </label>
            {SHARED_TOLRA_AI_ACTIVE ? <label className="flex items-start gap-2">
              <input type="radio" name="ai-provider" value="tolra" checked={provider === "tolra"} onChange={() => setPicked("tolra")} />
              <span>Tolra-provided AI (Tolra&apos;s account, with a monthly allowance for your company){status?.tolra_available ? "" : " (not available)"}</span>
            </label> : null}
            {model.on === true ? <p className="text-xs text-slate-500">Turn AI off to change who provides it.</p> : null}
          </fieldset>
          {model.capLine ? <p data-testid="ai-cap-line">{model.capLine}</p> : null}
          {model.assistant ? <p data-testid="ai-assistant-line" data-state={model.assistant.state}>{model.assistant.text}</p> : null}
          {provider === "anthropic" && canManage ? (
            <form onSubmit={(event) => void saveKey(event)} className="grid gap-2" aria-label="Anthropic API key">
              <p>
                Get a key from Anthropic:{" "}
                <a href={ANTHROPIC_KEYS_URL} target="_blank" rel="noopener noreferrer" className="underline">{ANTHROPIC_KEYS_URL}</a>
              </p>
              <label htmlFor="ai-key" className="font-medium">{model.keySaved ? "New Anthropic API key (replaces the saved one)" : "Anthropic API key"}</label>
              <Input id="ai-key" name="ai-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="sk-ant-…" />
              <p className="text-xs text-slate-500">It is stored encrypted and is never shown again. Saving it needs a fresh authenticator code.</p>
              <div>
                <Button type="submit" disabled={busy !== null || !key.trim()} className="min-h-9">{busy === "key" ? "Saving…" : model.keySaved ? "Replace key" : "Save key"}</Button>
                {model.keySaved ? <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void removeKey()} className="ml-2 min-h-9">Remove key</Button> : null}
              </div>
              <p className="text-xs text-slate-500">Replacing or removing the key switches AI off. You turn it on again with the switch above.</p>
            </form>
          ) : null}
          {SHARED_TOLRA_AI_ACTIVE && provider === "tolra" ? <p className="text-xs text-slate-500" data-testid="ai-limit-tolra-note">{TOLRA_LIMIT_NOTE}</p> : null}
          {provider === "anthropic" && canManage ? (
            <form onSubmit={(event) => void saveLimit(event)} className="grid gap-2" aria-label="Monthly limit">
              <label htmlFor="ai-limit" className="font-medium">Monthly limit (£)</label>
              <Input id="ai-limit" name="ai-limit" inputMode="decimal" autoComplete="off" value={limitDraft ?? (status!.monthly_cap_pence / 100).toFixed(2)} onChange={(event) => setLimitDraft(event.target.value)} className="max-w-40" />
              <p className="text-xs text-slate-500">When the limit is reached AI stops for the month. Saving it never turns AI on or off. If AI is on, saving asks for a fresh authenticator code.</p>
              <div>
                <Button type="submit" disabled={busy !== null || limitDraft === null} className="min-h-9">{busy === "limit" ? "Saving…" : "Save limit"}</Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      {notice ? <p role="status" data-testid="ai-notice" className={notice.tone === "ok" ? "text-emerald-800" : "text-amber-800"}>{notice.text}</p> : null}
    </SetupCard>
  );
}
