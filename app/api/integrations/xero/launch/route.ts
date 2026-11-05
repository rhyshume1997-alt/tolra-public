import {NextResponse} from 'next/server';
import {forbiddenOrigin,isErrorResponse,jsonError,readJson,requireProfile,sameOrigin} from '@/lib/server/auth';
/** Existing admin auth pattern; the DB setter also requires admin MFA and support-read-only. */
export async function GET(){
 const auth=await requireProfile(['admin']);if(isErrorResponse(auth))return auth;
 if(auth.session?.support)return jsonError('Support access cannot change Xero transfers.',403);
 const {data,error}=await auth.supabase.rpc('integration_xero_launch_status');
 return error?jsonError('Xero transfer controls are unavailable. Nothing was changed.',503):NextResponse.json(data);
}
export async function POST(request:Request){
 if(!sameOrigin(request))return forbiddenOrigin();
 const auth=await requireProfile(['admin']);if(isErrorResponse(auth))return auth;
 if(auth.session?.support)return jsonError('Support access cannot change Xero transfers.',403);
 const body=await readJson(request,1024);if(!body.ok)return body.response;
 const value=body.data as {enabled?:unknown}|null;
 if(!value||typeof value.enabled!=='boolean')return jsonError('Choose on or off.',400);
 const {error}=await auth.supabase.rpc('integration_xero_set_transfers',{p_enabled:value.enabled});
 return error?jsonError('Xero transfers were not changed. Check your admin sign-in and connection.',409):NextResponse.json({enabled:value.enabled});
}
