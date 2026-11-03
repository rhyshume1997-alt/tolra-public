import { expect, type Locator } from "@playwright/test";

async function replaceField(card:Locator,label:string,value:string) {
  const group=card.getByRole("group",{name:label,exact:true});
  const remove=group.getByRole("button",{name:/^Remove /});
  while(await remove.count()) await remove.first().click();
  await group.getByRole("textbox").first().fill(value);
}

/** Reconstruct the flat saved text from interleaved text boxes and named chips.
 * This keeps the old browser tests' exact round-trip assertions, not just a
 * weaker preview/contains check, while supporting both sides of the N6 rollout.
 */
async function fieldText(card:Locator,label:string) {
  return card.getByRole("group",{name:label,exact:true}).evaluate(group=>{
    const options=[...group.querySelectorAll("option")];
    const row=group.querySelector("div")!;
    return [...row.children].map(child=>{
      if(child instanceof HTMLTextAreaElement)return child.value;
      const copy=child.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("button").forEach(button=>button.remove());
      const label=copy.textContent??"";
      const name=options.find(option=>option.textContent===label)?.value;
      if(!name)throw new Error(`Unrecognised detail chip: ${label}`);
      return `{{${name}}}`;
    }).join("");
  });
}
export async function fillTemplateSubject(card:Locator,value:string) {
  const old=card.getByLabel("Subject",{exact:true});
  if(await old.count())await old.fill(value);else await replaceField(card,"Subject line",value);
}
export async function fillTemplateBody(card:Locator,value:string) {
  const old=card.getByLabel("Text",{exact:true});
  if(await old.count())await old.fill(value);
  else {
    await replaceField(card,"Greeting","");await replaceField(card,"Sign-off","");
    await replaceField(card,"Main message",value);
  }
}
export async function expectTemplateSubject(card:Locator,value:string) {
  const old=card.getByLabel("Subject",{exact:true});
  if(await old.count())await expect(old).toHaveValue(value);
  else await expect.poll(()=>fieldText(card,"Subject line")).toBe(value);
}
export async function expectTemplateBody(card:Locator,value:string) {
  const old=card.getByLabel("Text",{exact:true});
  if(await old.count())await expect(old).toHaveValue(value);
  else await expect.poll(async()=>{
    const values=[];
    for(const label of ["Greeting","Main message","Sign-off"])values.push(await fieldText(card,label));
    return values.filter(value=>value!=="").join("\n\n");
  }).toBe(value);
}
