"use client";
import { useRef, useState } from "react";
import { detailParts, detailText, detailLabel, insertDetail } from "@/lib/email/templates/editor";

export function TemplateDetailField({id,label,hint,value,allowed,readOnly,onChange,singleLine=false}:{id:string;label:string;hint:string;value:string;allowed:readonly string[];readOnly:boolean;onChange:(value:string)=>void;singleLine?:boolean}) {
 const cursor=useRef({index:0,position:0});
 const [choice,setChoice]=useState(allowed[0]??"");
 const parts=detailParts(value);
 return <fieldset className="rounded border p-3" aria-label={label}>
  <legend className="px-1 text-sm font-semibold">{label}</legend><p className="mb-2 text-xs text-slate-600">{hint}</p>
  <div className="flex flex-wrap items-center gap-1">{parts.map((part,index)=>part.kind==="detail"
   ? <span key={index} className="inline-flex items-center gap-1 rounded bg-blue-50 p-2 text-sm">{detailLabel(part.name)}{!readOnly&&<button type="button" aria-label={`Remove ${detailLabel(part.name)} from ${label}`} onClick={()=>onChange(detailText(parts.filter((_,i)=>i!==index)))}>×</button>}</span>
   : <textarea key={index} id={index===0?id:undefined} aria-label={`${label} text ${index+1}`} rows={singleLine?1:3} value={part.text} readOnly={readOnly} className="min-w-32 flex-1 rounded border p-2 text-sm" onSelect={e=>{cursor.current={index,position:e.currentTarget.selectionStart};}} onFocus={e=>{cursor.current={index,position:e.currentTarget.selectionStart};}} onChange={e=>{
     const next=[...parts];next[index]={kind:"text",text:singleLine?e.target.value.replace(/[\r\n\u2028\u2029]+/g,' '):e.target.value};onChange(detailText(next));
   }}/>)}</div>
  {!readOnly&&allowed.length>0&&<div className="mt-2 flex flex-wrap items-center gap-2"><label className="text-xs">Insert detail into {label}<select aria-label={`Detail for ${label}`} value={choice} onChange={e=>setChoice(e.target.value)} className="ml-2 rounded border p-2">{allowed.map(name=><option key={name} value={name}>{detailLabel(name)}</option>)}</select></label><button type="button" className="rounded border px-3 py-2 text-sm" onClick={()=>onChange(insertDetail(value,cursor.current.index,cursor.current.position,choice,allowed))}>Add detail</button></div>}
 </fieldset>;
}
