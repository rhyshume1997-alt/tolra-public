// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TolraAiControl } from "@/components/platform/tolra-ai-control";

let host:HTMLDivElement;
let root:Root;
const fetcher=vi.fn<typeof fetch>();
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  vi.stubGlobal("fetch",fetcher);fetcher.mockReset();
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const status=(enabled=false)=>new Response(JSON.stringify({enabled,key_set:true}),{status:200});
async function mount() {
  fetcher.mockResolvedValueOnce(status());
  await act(async()=>root.render(createElement(TolraAiControl)));
}
function typeKey(value:string) {
  const input=host.querySelector("input")!;
  act(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
}
async function click(text:string) {
  await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent?.startsWith(text))!.click());
}
it("never fills the key input with a saved key, and clears a replacement immediately after submitting",async()=>{
  await mount();expect(host.querySelector("input")!.value).toBe("");
  expect(host.querySelector("input")!.type).toBe("password");
  typeKey("sk-ant-SYNTHETIC-owner-replacement-key");
  fetcher.mockResolvedValueOnce(status(true));await click("Switch on");
  expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body))).toEqual({enabled:true,key:"sk-ant-SYNTHETIC-owner-replacement-key"});
  expect(host.querySelector("input")!.value).toBe("");
  expect(host.textContent).not.toContain("SYNTHETIC");
});
it("can switch off even if an invalid replacement is half-written",async()=>{
  await mount();typeKey("unfinished key");fetcher.mockResolvedValueOnce(status(false));await click("Switch off");
  expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body))).toEqual({enabled:false});
  expect(host.querySelector("input")!.value).toBe("");
});
it("clears the entered key after a refused save too, without echoing it in errors",async()=>{
  await mount();typeKey("sk-ant-SYNTHETIC-secret");fetcher.mockResolvedValueOnce(new Response("{}",{status:403}));await click("Switch on");
  expect(host.querySelector("input")!.value).toBe("");expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).not.toContain("SYNTHETIC");
});
it("offers no key entry when the owner API refuses the viewer",async()=>{
  fetcher.mockResolvedValueOnce(new Response("{}",{status:403}));
  await act(async()=>root.render(createElement(TolraAiControl)));
  expect(host.querySelector("input")).toBeNull();expect(host.querySelector("button")).toBeNull();
});
