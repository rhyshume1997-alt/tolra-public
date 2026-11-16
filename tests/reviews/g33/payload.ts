import { createHash } from 'node:crypto';
import { buildImport } from '@/lib/import-build';
import { planSheet } from '@/lib/import-detect';
import { parseCsv,preprocess } from './preprocess.mjs';
export const CUSTOMER='G33 Synthetic Metal Ltd';
export const csv=(rows:string[][])=>rows.map(r=>r.map(c=>`"${c.replaceAll('"','""')}"`).join(',')).join('\r\n');
export function report(tag:string,bad=false) {
 return csv([['SYNTHETIC SliQ-shaped invoice report'],['Made-up company'],[],['Type','Num','Date','Customer','Net Total','VAT','Total'],['Year 2026'],
 ['Inv',`G33-${tag}-1`,'01/10/2026',CUSTOMER,'100.05','20.01','120.06'],
 ['Inv',`G33-${tag}-2`,bad?'31/02/2026':'02/10/2026',CUSTOMER,'20.00','4.00','24.00'],['Total','','','','120.05','24.01','144.06']]);
}
export async function payload(tag:string) {
 const clean=preprocess(report(tag),{kind:'invoices'});
 const payments=preprocess(csv([['SYNTHETIC payments'],['Payment Date','Payment Method','Customer','Num','Payment Net','VAT','Payment Amount'],['03/10/2026','Bank Transfer',CUSTOMER,`G33-${tag}-1`,'50.00','10.00','60.00'],['Total','','','','50.00','10.00','60.00']]),{kind:'payments',invoicesClean:clean.files['invoices.csv']});
 // The public synthetic preprocessor supports invoices/payments. Supplemental canonical sheets use the real page mapper.
 const files={...clean.files,...payments.files,
  'customers.csv':csv([['Name'],[CUSTOMER]]),
  'credit_notes.csv':csv([['Credit note number','Invoice number','Customer','Credit note date','Net','VAT','Total'],[`CRD-${tag}`,`G33-${tag}-2`,CUSTOMER,'2026-10-03','10.00','2.00','12.00']]),
  'delivery_notes.csv':csv([['Delivery note number','Customer','Invoice number','Delivery date','Description','Quantity'],[`DLN-${tag}`,CUSTOMER,`G33-${tag}-1`,'2026-10-04','Synthetic bracket','1']])};
 const plans=[];
 for(const [name,text] of Object.entries(files)) {
  const rows=parseCsv(text);
  plans.push(...await planSheet({name:name.replace('.csv',''),headers:rows[0],rows:rows.slice(1),rowNumbers:rows.slice(1).map((_,i)=>i+2)},[]));
 }
 const built=buildImport(plans,{name:`g33-${tag}.csv`,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')});
 if(built.problems.length || built.payload.invoices?.length!==2 || built.payload.delivery_notes?.length!==1 || built.payload.credit_notes?.length!==1)throw new Error('Synthetic sheets did not map to expected records');
 const p=built.payload;
 // Original safeupdate suite's remaining record kinds, supplied as explicit synthetic supplement records.
 p.suppliers=[{name:`G33 Steel ${tag}`}];p.stock=[{sku:`G33-${tag}`,material:'Synthetic EN8',current_stock:'3',unit_price:'4.25'}];
 p.quotes=[{quote_ref:`QG33-${tag}`,customer:CUSTOMER,status:'sent',quote_date:'2026-10-01',total_value:120}];
 p.sales_orders=[{so_number:`SOG33-${tag}`,customer:CUSTOMER}];p.jobs=[{job_no:`JG33-${tag}`,customer:CUSTOMER,so_number:`SOG33-${tag}`}];
 p.purchase_orders=[{po_ref:`POG33-${tag}`,supplier:`G33 Steel ${tag}`,total_value:99}];
 return {p,counts:clean.counts};
}
