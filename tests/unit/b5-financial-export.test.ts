import {expect,it,vi} from 'vitest';
import readExcelFile from 'read-excel-file/node';
import {toCsv,toXlsx,type SheetColumn} from '@/lib/spreadsheet';
vi.mock('@/lib/supabase',()=>({supabase:null}));
import {summaryCsv,type SummaryRow} from '@/lib/year-end-export';
const columns:SheetColumn<{value:number|null}>[]=[{header:'Money',type:'money',value:r=>r.value}];
it.each([[1.005,'1.01'],[-1.005,'-1.01'],[2.675,'2.68'],[-2.675,'-2.68']] as const)('file export %s rounds exact decimal pennies halves away from zero',async(value,want)=>{
 expect(toCsv(columns,[{value}])).toBe(`\uFEFFMoney\r\n${want}\r\n`);
 expect(await readExcelFile(Buffer.from(await toXlsx('Synthetic',columns,[{value}])))).toEqual([{sheet:'Synthetic',data:[['Money'],[Number(want)]]}]);
 const row:SummaryRow={type:'Invoice',number:'SYN-1',date:'2026-11-05',party:'Synthetic',net:value,vat:0,gross:value,paidDate:'',status:'sent',pdf:''};
 expect(summaryCsv([row])).toContain(`Synthetic,${want},0.00,${want},`);
});
it('blank money stays blank in both file formats, no invented zero',async()=>{
 expect(toCsv(columns,[{value:null}])).toBe('\uFEFFMoney\r\n\r\n');
 expect(await readExcelFile(Buffer.from(await toXlsx('Synthetic',columns,[{value:null}])))).toEqual([{sheet:'Synthetic',data:[['Money']]}]);
});
