import { expect,it } from "vitest";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, SAMPLE_VARS, renderTemplate } from "@/lib/email/templates/defaults";
import { detailParts,detailText,emailSections,sectionsBody,insertDetail,changeSection } from "@/lib/email/templates/editor";
it.each(TEMPLATE_KEYS)("keeps the exact saved format and preview for %s",key=>{
 const t=DEFAULT_TEMPLATES[key];expect(detailText(detailParts(t.subject))).toBe(t.subject);expect(sectionsBody(emailSections(t.body))).toBe(t.body);
 expect(renderTemplate(key,SAMPLE_VARS,{subject:detailText(detailParts(t.subject)),body:sectionsBody(emailSections(t.body))})).toEqual(renderTemplate(key,SAMPLE_VARS,t));
});
it.each(['','Hello','A\n\n\nB\n\n','Hi {{customer_name}}\n\nMessage\n\nRegards,\n{{company_name}}','Dear {{person_name}}\nMessage\nThanks','{{unknown}} and {{total}}'])('preserves legacy text exactly: %j',body=>{
 expect(detailText(detailParts(body))).toBe(body);expect(sectionsBody(emailSections(body))).toBe(body);
});
it('inserts only an allowed detail at the selected caret, with no bracket typing',()=>{
 expect(insertDetail('Please pay ',0,11,'balance',['balance'])).toBe('Please pay {{balance}}');
 expect(insertDetail('Text',0,2,'secret',['balance'])).toBe('Text');
});
it('changes one labelled section without losing old details or sign-off',()=>{
 const t={subject:'Invoice {{document_number}}',body:'Hi {{customer_name}}\n\nOld {{balance}}\n\nKind regards,\n{{company_name}}'};
 expect(changeSection(t,'message','New {{due_date}}')).toEqual({...t,body:'Hi {{customer_name}}\n\nNew {{due_date}}\n\nKind regards,\n{{company_name}}'});
});
