import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
/** File workflow only. No connection, token or provider request exists here. */
export function SageFileCard(){
 return <Card data-testid="sage-file-export"><CardHeader><CardTitle>Sage (file export)</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p>Download the existing accounting files for your accountant to use with Sage. This does not connect to Sage or send records.</p><p>The files contain invoices, credit notes and recorded payments. Your accountant must check the column mapping and import rules for their Sage product before use.</p><a className="font-medium underline" href="/settings#year-end-export">Open accounting file export</a></CardContent></Card>;
}
