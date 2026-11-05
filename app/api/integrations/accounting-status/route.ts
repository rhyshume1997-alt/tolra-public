import {NextResponse} from 'next/server';
import {accountingStatuses} from '@/lib/integrations/accounting-status';
import type {IntegrationOverview} from '@/lib/integrations/overview';
import {xeroReady} from '@/lib/integrations/server';
import {isErrorResponse,jsonError,requireProfile} from '@/lib/server/auth';
export async function GET(){
 const auth=await requireProfile(['admin']);if(isErrorResponse(auth))return auth;
 if(auth.session?.support)return jsonError('Support access cannot read accounting status.',403);
 const org=auth.profile.organization_id;
 const [config,overview,launch,last]=await Promise.all([
  xeroReady().then(Boolean).catch(()=>null),
  auth.supabase.rpc('integration_overview',{p_provider:'xero'}),
  auth.supabase.rpc('integration_xero_launch_status'),
  auth.supabase.from('integration_sends').select('status,updated_at').eq('organization_id',org).eq('provider','xero').order('updated_at',{ascending:false}).limit(1),
 ]);
 const enabled=!launch.error&&typeof launch.data?.enabled==='boolean'?launch.data.enabled:null;
 return NextResponse.json({providers:accountingStatuses({configured:config,overview:overview.error?null:overview.data as IntegrationOverview,enabled,last:last.error?null:last.data?.[0]??null,lastReadOk:!last.error})},{headers:{'cache-control':'no-store'}});
}
