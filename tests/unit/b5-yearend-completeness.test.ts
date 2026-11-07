import {expect,it,vi} from 'vitest';
import {JNR_PROFILE} from '@/lib/company';
vi.mock('@/lib/supabase',()=>({supabase:{from:()=>({select:()=>({order:()=>({range:async()=>({data:[],error:null})})})})}}));
vi.mock('@/lib/fetch-all',()=>({fetchAll:async()=>({rows:[],truncated:true})}));
vi.mock('@/lib/audit',()=>({auditEvent:vi.fn(async()=>undefined)}));
import {buildYearEndZip} from '@/lib/year-end-export';
it('refuses a source read marked truncated rather than issuing a seemingly complete accountant export',async()=>{
 await expect(buildYearEndZip('2026-01-01','2026-12-31',{...JNR_PROFILE,name:'Synthetic company'})).rejects.toThrow(/complete export|export stopped/i);
});
