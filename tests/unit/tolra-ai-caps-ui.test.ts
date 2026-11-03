// @vitest-environment jsdom
import { act,createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect,it,vi } from "vitest";
import { TolraAiCaps } from "@/components/platform/tolra-ai-caps";

it("shows the upper limit and saves only the chosen company's whole-pence cap",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const companies=[{organizationId:"company-a",name:"A",monthlyCapPence:1000,spentPence:0,reservedPence:0},{organizationId:"company-b",name:"B",monthlyCapPence:1000,spentPence:0,reservedPence:0}];
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
    if(init?.method==="POST")return Response.json({ok:true});
    return Response.json({companies});
  });vi.stubGlobal("fetch",fetcher);
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(createElement(TolraAiCaps)));
    expect(host.textContent).toContain("Maximum: 100,000p (£1,000)");
    const inputs=host.querySelectorAll("input");expect(inputs).toHaveLength(2);
    expect(inputs[0].max).toBe("100000");expect(inputs[1].value).toBe("1000");
    act(()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(inputs[0],"750");
      inputs[0].dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="Save limit for A")!.click());
    const posts=fetcher.mock.calls.filter(call=>call[1]?.method==="POST");expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({organizationId:"company-a",monthlyCapPence:750});
    expect(inputs[1].value).toBe("1000");
  } finally {act(()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
