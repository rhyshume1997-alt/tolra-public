// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org-1" }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "office" }) }));
import { EmailTemplateEditor } from "@/components/email/email-templates-card";
import { TemplateDetailField } from "@/components/email/template-detail-field";
import { renderTemplate, SAMPLE_VARS } from "@/lib/email/templates/defaults";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each(["invoice_reminder", "timesheet"] as const)("inserts details and updates the %s preview without typing brackets or saving", key => {
  const save = vi.fn();
  function Editor() {
    const [body, setBody] = useState("Hello ");
    return createElement("div", {},
      createElement(TemplateDetailField, { id: "message", label: "Main message", hint: "Write your message.", value: body, allowed: ["company_name"], readOnly: false, onChange: setBody }),
      createElement("output", {}, renderTemplate(key, SAMPLE_VARS, {subject: "Subject", body}).text),
      createElement("button", {onClick: () => save(body)}, "Save"));
  }
  act(() => root.render(createElement(Editor)));
  const area = host.querySelector("textarea")!;
  act(() => { area.focus(); area.setSelectionRange(6, 6); area.dispatchEvent(new MouseEvent("mouseup", {bubbles: true})); });
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Add detail")!.click());
  expect([...host.querySelectorAll("textarea")].map(t => t.value).join("")).toBe("Hello ");
  expect(host.textContent).toContain("Your company name");
  expect(host.querySelector("output")!.textContent).toBe(`Hello ${SAMPLE_VARS.company_name}`);
  expect(save).not.toHaveBeenCalled();
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Save")!.click());
  expect(save).toHaveBeenCalledWith("Hello {{company_name}}");
});

it("locks all editing for read-only users and while saving", () => {
  const change = vi.fn();
  act(() => root.render(createElement(TemplateDetailField, {id:"body",label:"Greeting",hint:"Say hello.",value:"Hi {{customer_name}}",allowed:["customer_name"],readOnly:true,onChange:change})));
  expect(host.querySelector("textarea")!.readOnly).toBe(true);
  expect(host.querySelectorAll("button, select")).toHaveLength(0);
  expect(change).not.toHaveBeenCalled();
});

it("keeps half-written greeting and sign-off in their labelled boxes", () => {
  function Editor() {
    const [value, setValue] = useState({subject:"Subject",body:"Main message"});
    return createElement(EmailTemplateEditor, {templateKey:"invoice_reminder",value,custom:false,dirty:true,canEdit:true,busy:false,onChange:setValue,onSave:vi.fn(),onReset:vi.fn()});
  }
  act(() => root.render(createElement(Editor)));
  function type(label: string, value: string) {
    const area = host.querySelector(`[aria-label="${label} text 1"]`)!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
      area.dispatchEvent(new Event("input", {bubbles:true}));
    });
  }
  type("Greeting", "H"); type("Greeting", "Hello"); type("Sign-off", "S");
  expect((host.querySelector('[aria-label="Greeting text 1"]') as HTMLTextAreaElement).value).toBe("Hello");
  expect((host.querySelector('[aria-label="Sign-off text 1"]') as HTMLTextAreaElement).value).toBe("S");
  expect((host.querySelector('[aria-label="Main message text 1"]') as HTMLTextAreaElement).value).toBe("Main message");
  expect(host.querySelector('[data-testid="email-template-invoice_reminder-preview-body"]')!.textContent).toBe("Hello\n\nMain message\n\nS");
});
