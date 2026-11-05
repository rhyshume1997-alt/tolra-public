import type {IntegrationOverview} from '@/lib/integrations/overview';
export type AccountingStatus={id:string;name:string;available:boolean;configuration:string;connection:string;mapping:string;readiness:string;lastTransfer:string;updatedAt:string|null};
/** Local capability/readiness only. Never claims a live provider was tested or a transfer occurred from configuration alone. */
export function accountingStatuses(input:{configured:boolean|null;overview:IntegrationOverview|null;enabled:boolean|null;last:{status:string;updated_at?:string}|null;lastReadOk:boolean}):AccountingStatus[]{
 const o=input.overview;const connected=o?.status==='connected';
 const mapping=o?(o.unmapped.length?'Mapping outstanding':'Mapped'):'Unknown';
 let readiness='Not ready';
 if(input.configured===null||!o||input.enabled===null)readiness='Unknown';
 else if(!input.enabled)readiness='Transfers OFF';
 else if(input.configured&&connected&&!o.unmapped.length&&!o.contact_problems)readiness='Ready';
 const last=input.lastReadOk?(input.last?({sent:'Succeeded',failed:'Failed',needs_check:'Needs checking',pending:'Waiting',sending:'Sending',skipped:'Not sent'} as Record<string,string>)[input.last.status]??'Unknown':'No transfers recorded'):'Unknown';
 return [{id:'xero',name:'Xero',available:true,configuration:input.configured===null?'Unknown':input.configured?'Configured':'Needs configuration',connection:!o?'Unknown':connected?'Connected':o.status==='needs_reconnect'?'Reconnect needed':'Not connected',mapping,readiness,lastTransfer:last,updatedAt:input.last?.updated_at??null},
 {id:'sage-files',name:'Sage (file export)',available:true,configuration:'No online configuration',connection:'File export only',mapping:'Accountant checks file mapping',readiness:'File export available',lastTransfer:'No online transfers',updatedAt:null}];
}
