import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SageFileCard} from '@/components/integrations/sage-file-card';
import {summaryCsv,creditsCsv,paymentsCsv,invoicePaidFigures} from '@/lib/year-end-export';
it('labels Sage as file export with no connector or transfer action',()=>{
 const html=renderToStaticMarkup(createElement(SageFileCard));
 expect(html).toContain('Sage (file export)');expect(html).toContain('/settings#year-end-export');
 expect(html).toContain('does not connect to Sage');expect(html).not.toContain('<button');
});
it('reuses invoice accounting CSV with ISO dates, pennies, BOM and formula guard',()=>{
 const csv=summaryCsv([{type:'Invoice',number:'SYN-1',date:'2026-11-05',party:'=SYNTHETIC()',net:100,vat:20,gross:120,paid:60,balance:60,paidDate:'2026-11-05',status:'partial',pdf:''}]);
 expect(csv.charCodeAt(0)).toBe(0xfeff);expect(csv).toContain("2026-11-05,'=SYNTHETIC(),100.00,20.00,120.00,60.00,60.00");expect(csv.endsWith('\r\n')).toBe(true);
});
it('exports credits separately from payments with applied and remaining amounts',()=>{
 const csv=creditsCsv([{credit:'SYN-C1',invoice:'SYN-1',date:'2026-11-05',customer:'Synthetic',net:10,vat:2,gross:12,applied:6,left:6,lastApplied:'2026-11-05'}]);
 expect(csv).toContain('SYN-C1,SYN-1,2026-11-05,Synthetic,10.00,2.00,12.00,6.00,6.00,2026-11-05');
 expect(paymentsCsv([])).not.toContain('SYN-C1');
});
it('keeps unknown paid and balance figures blank rather than inventing zero',()=>{
 expect(invoicePaidFigures({invoice_ref:'SYN-2',status:'sent',total:120,payment_unverified:true})).toMatchObject({paid:null,balance:null});
});
it('preserves payment reversals and neutralises reference formula cells',()=>{
 const csv=paymentsCsv([{invoice:'SYN-1',paidOn:'2026-11-05',amount:-10,method:'BACS',reference:'@SYNTHETIC',source:'recorded',reversed:'Reversal'}]);
 expect(csv).toContain("-10.00,BACS,'@SYNTHETIC,recorded,Reversal");
});
