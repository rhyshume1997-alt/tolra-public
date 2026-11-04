// Offline comparison only. No database client, network, file writes or customer names in the report.
import {createHash} from 'node:crypto';
const integer = /^-?(0|[1-9]\d*)$/;
export function pence(value) {
  if (typeof value !== 'string' || !integer.test(value)) throw Error('Money must be an exact integer pence string');
  return BigInt(value);
}
// For a calculated source value only. Imported invoice totals must already be integer pence.
export function halfEven(numerator, denominator) {
  const n=pence(numerator), d=pence(denominator);
  if(d<=0n)throw Error('Denominator must be positive');
  const sign=n<0n?-1n:1n, a=n<0n?-n:n, q=a/d, r=a%d;
  return String(sign*(q+(r*2n>d || (r*2n===d && q%2n!==0n)?1n:0n)));
}
function canonical(v) {
  if(Array.isArray(v))return '['+v.map(canonical).sort().join(',')+']';
  if(v && typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const fingerprint=v=>createHash('sha256').update(canonical(v)).digest('hex');
function indexed(rows, company, kind) {
  if(!Array.isArray(rows))throw Error('Missing '+kind);
  const map=new Map();
  for(const row of rows){
    if(row.company!==company || typeof row.sourceRef!=='string' || !row.sourceRef || map.has(row.sourceRef))throw Error('Foreign, missing or duplicate stable reference in '+kind);
    map.set(row.sourceRef,row);
  }
  return map;
}
function normalise(s,company){
  const customers=indexed(s.customers,company,'customers'), invoices=indexed(s.invoices,company,'invoices'), payments=indexed(s.payments,company,'payments'),jobs=indexed(s.jobs,company,'jobs');
  const amounts=new Map([...customers.keys()].map(k=>[k,0n]));
  for(const row of invoices.values()){
    if(!customers.has(row.customerRef))throw Error('Unknown customer reference');
    const total=pence(row.totalPence), paid=pence(row.paidPence), credit=pence(row.creditPence), refunded=pence(row.refundPence);
    if(total<0n || paid<0n || credit<0n || refunded<0n)throw Error('Negative invoice or allocation requires separate credit/refund evidence');
    const balance=total-paid-credit+refunded;
    if(balance<0n)throw Error('Over-allocation requires separate credit evidence');
    amounts.set(row.customerRef,amounts.get(row.customerRef)+balance);
    row.balancePence=String(balance);
    let allocated=0n;
    for(const payment of payments.values())if(payment.invoiceRef===row.sourceRef)allocated+=pence(payment.amountPence);
    if(allocated!==paid)throw Error('Payment rows do not match invoice paid amount');
  }
  for(const row of payments.values())if(!invoices.has(row.invoiceRef) || pence(row.amountPence)<0n)throw Error('Invalid payment reference or amount');
  for(const row of jobs.values())if(!customers.has(row.customerRef))throw Error('Unknown job customer');
  if(!s.numbering || typeof s.numbering!=='object' || Array.isArray(s.numbering) || !Object.keys(s.numbering).length)throw Error('Missing numbering');
  for(const n of Object.values(s.numbering))if(pence(n)<0n)throw Error('Invalid numbering');
  return {customers:[...customers.values()],invoices:[...invoices.values()],payments:[...payments.values()],jobs:[...jobs.values()],customerBalances:Object.fromEntries([...amounts].map(([k,v])=>[k,String(v)])),numbering:s.numbering};
}
export function reconcile(input){
  try{
    const data=structuredClone(input); // Never mutate the supplied snapshots.
    if(typeof data.company!=='string' || !data.company || data.company===data.protectedCompany)throw Error('Two distinct company identities required');
    const expected=normalise(data.expected,data.company),actual=normalise(data.actual,data.company);
    const checks=Object.keys(expected).map(area=>({area,matched:canonical(expected[area])===canonical(actual[area])}));
    const before=data.preservationBefore,after=data.preservationAfter;
    // Caller must supply the reviewed complete inventory, not a selected sample of Marpet rows.
    if(!data.protectedCompany || !Array.isArray(data.protectedInventory) || !data.protectedInventory.length || new Set(data.protectedInventory).size!==data.protectedInventory.length)throw Error('Missing preservation inventory');
    for(const category of ['marpet','logins','settings','numbering','audit']){
      if(!before || !after || before[category]===undefined || after[category]===undefined)throw Error('Missing preservation category');
      checks.push({area:'preservation-'+category,matched:canonical(before[category])===canonical(after[category])});
    }
    const tables=data.protectedInventory.slice().sort();
    if(canonical(Object.keys(before.marpet).sort())!==canonical(tables) || canonical(Object.keys(after.marpet).sort())!==canonical(tables))throw Error('Incomplete Marpet inventory');
    for(const snapshot of [before.marpet,after.marpet])for(const rows of Object.values(snapshot)){
      if(!Array.isArray(rows) || rows.some(row=>row.company!==data.protectedCompany))throw Error('Foreign or missing Marpet company');
    }
    return {status:checks.every(c=>c.matched)?'PASS':'FAIL',exactPence:true,marpetUnchanged:checks.find(c=>c.area==='preservation-marpet').matched,matched:checks.every(c=>c.matched),checks,sourceFingerprint:fingerprint(data.expected),targetFingerprint:fingerprint(data.actual),note:'Only supplied snapshots are proved. Completeness and extraction need independent review.'};
  }catch(error){return {status:'FAIL',matched:false,exactPence:false,marpetUnchanged:false,reason:error.message};}
}
