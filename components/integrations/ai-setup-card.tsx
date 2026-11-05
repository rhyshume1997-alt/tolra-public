"use client";

import { useState, type FormEvent } from "react";

import { useAiFeatures } from "@/components/ai-features";
import { useAiHelperStatus, type AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { SetupCard } from "@/components/integrations/setup-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ANTHROPIC_KEYS_URL, KEY_SHAPE_MESSAGE, type AiProvider, buildAiSetup, effectiveProvider, keyLooksRight, postJson, safeMessage, switchRequest,
} from "@/lib/integrations/ai-setup";
import { sendWithCode } from "@/lib/mfa-step-up";

/**
 * Admin > Integrations > AI: guided setup in the shared SetupCard frame.
 *   1. choose who provides the AI (Anthropic with the company's own key, or Tolra-provided);
 *   2. get a key (plain link to the Anthropic Console, opens in a new tab);
 *   3. paste the key (password field) and save it: sent once to /api/ai-helper/key, which encrypts it. It is never shown again, the field is
 *      emptied the moment Save is pressed, and only "saved" and the last four characters come back;
 *   4. "Turn on AI": its own switch, OFF by default, never changed by saving or replacing a key. Turning it on needs an admin and a fresh
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
  const [busy, setBusy] = useState<"key" | "switch" | null>(null);
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
    setBusy("key");
    setNotice(null);
    const outcome = await sendWithCode(send("/api/ai-helper/key", { key: value }), requestCode);
    if (outcome.result === "done") {
      await reload();
      setNotice({ tone: "ok", text: replacing ? "New key saved. It replaces the old key, which is no longer used. AI is not turned on by saving a key." : "Key saved. AI is not turned on by saving a key." });
    } else if (outcome.result === "cancelled") {
      setNotice({ tone: "error", text: "Cancelled. Nothing was changed." });
    } else {
      setNotice({ tone: "error", text: safeMessage(outcome.answer.body, "The key could not be saved. Try again.", value) });
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
            <label className="flex items-start gap-2">
              <input type="radio" name="ai-provider" value="tolra" checked={provider === "tolra"} onChange={() => setPicked("tolra")} />
              <span>Tolra-provided AI (Tolra&apos;s account, with a monthly allowance for your company){status?.tolra_available ? "" : " (not available)"}</span>
            </label>
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
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      {notice ? <p role="status" data-testid="ai-notice" className={notice.tone === "ok" ? "text-emerald-800" : "text-amber-800"}>{notice.text}</p> : null}
    </SetupCard>
  );
}
