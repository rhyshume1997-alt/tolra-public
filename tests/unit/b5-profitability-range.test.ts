import {expect,it} from 'vitest';
import {boughtIn,invoicedSellPence,linkedPoPence,profitFigure,quoteSellPence} from '@/lib/purchase-order-link';
const money='999999999999.99';
const invoices=(n:number)=>Array.from({length:n},(_,i)=>({id:`synthetic-${i}`,status:'sent',subtotal:money}));
const pos=(n:number)=>Array.from({length:n},(_,i)=>({id:`synthetic-${i}`,status:'sent',total_value:money}));
it('refuses unsafe invoiced totals before a falsely precise profit can be shown',()=>{expect(invoicedSellPence(invoices(91),[])).toEqual({issued:true,pence:null});});
it('does not accept a sum that lost precision before credits bring it back into range',()=>{
 expect(invoicedSellPence(invoices(91),[{invoice_id:'synthetic-0',status:'issued',subtotal:money}])).toEqual({issued:true,pence:null});
});
it('refuses unsafe supplier and quoted aggregates',()=>{
 expect(boughtIn(pos(91))).toBeNull();expect(quoteSellPence(Array.from({length:91},()=>({quantity:1,unit_price:money})))).toBeNull();
});
it('refuses a single value whose pennies are not safe integers',()=>{expect(linkedPoPence({id:'synthetic',total_value:'99999999999999999.99'})).toBeNull();});
it('refuses final profit overflow even when both sell and buy are safe',()=>{
 const out=profitFigure({kind:'job',canRead:{invoices:true,quotes:true,purchaseOrders:true},invoices:[{id:'synthetic-zero',status:'sent',subtotal:0}],credits:Array.from({length:90},()=>({invoice_id:'synthetic-zero',status:'issued',subtotal:money})),pos:pos(90),quoteLines:null});
 expect(out.state).toBe('unavailable');
});
it('keeps supported invoice/credit/supplier allocation maths and explicit zero unchanged',()=>{
 expect(profitFigure({kind:'job',canRead:{invoices:true,quotes:true,purchaseOrders:true},invoices:[{id:'i',status:'sent',subtotal:'200.00'}],credits:[{invoice_id:'i',status:'issued',subtotal:'10.00'}],pos:[{id:'p',total_value:'100.00',linked_net:'10.00'}],quoteLines:null})).toMatchObject({state:'actual',sellPence:19000,buyPence:1000,profitPence:18000});
 expect(boughtIn([])).toEqual({pence:0,count:0});
});
