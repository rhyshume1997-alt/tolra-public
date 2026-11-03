import type { TemplateText } from "./defaults";
export type DetailPart = { kind: "text"; text: string } | { kind: "detail"; name: string };
export function detailParts(text: string): DetailPart[] {
 const parts: DetailPart[] = []; let start = 0;
 for (const match of text.matchAll(/\{\{([a-z_]+)\}\}/g)) {
  parts.push({kind:"text",text:text.slice(start,match.index)}, {kind:"detail",name:match[1]}); start=match.index!+match[0].length;
 }
 parts.push({kind:"text",text:text.slice(start)});return parts;
}
export const detailText = (parts: DetailPart[]) => parts.map(p=>p.kind==="text"?p.text:`{{${p.name}}}`).join("");
export function insertDetail(text:string,index:number,position:number,name:string,allowed: readonly string[]) {
 if(!allowed.includes(name))return text;
 const parts=detailParts(text);const part=parts[index];if(!part||part.kind!=="text")return text;
 const at=Math.max(0,Math.min(position,part.text.length));
 parts.splice(index,1,{kind:"text",text:part.text.slice(0,at)},{kind:"detail",name},{kind:"text",text:part.text.slice(at)});
 return detailText(parts);
}
export type EmailSections = { greeting:string; message:string; signoff:string };
export function emailSections(body:string):EmailSections {
 const paragraphs=body.split("\n\n");let greeting="",signoff="";
 if(paragraphs.length>1&&/^(hi\b|hello\b|dear\b|good morning\b|\{\{greeting\}\})/i.test(paragraphs[0])) greeting=paragraphs.shift()!;
 if(paragraphs.length>1&&/^(thanks\b|thank you\b|kind regards\b|best regards\b|regards\b|yours\b|cheers\b)/i.test(paragraphs.at(-1)!)) signoff=paragraphs.pop()!;
 return {greeting,message:paragraphs.join("\n\n"),signoff};
}
export const sectionsBody = (s:EmailSections)=>[s.greeting,s.message,s.signoff].filter(s=>s!=="").join("\n\n");
export function changeSection(template:TemplateText,section:keyof EmailSections,value:string):TemplateText {
 return {...template,body:sectionsBody({...emailSections(template.body),[section]:value})};
}
const LABELS:Record<string,string>={customer_name:"Customer name",document_number:"Document number",total:"Original amount",balance:"Amount still owed",due_date:"Due date",company_name:"Your company name",person_name:"Contact name",days_overdue:"Days overdue",week:"Week",hours:"Hours",link:"Link",greeting:"Greeting",payment_note:"Payment note",job:"Job",job_number:"Job number",job_status:"Job status",delivery_date:"Delivery date",status:"Status",description:"Description"};
export const detailLabel=(name:string)=>LABELS[name]??`Saved detail: ${name.replaceAll('_',' ')}`;
