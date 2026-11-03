import { describe, expect, it } from 'vitest';
import { parseCsv, parseDate, parseMoneyPence, ParseError } from '../../scripts/sliq-import/parse.mjs';
import { detectDateFormat } from '../../scripts/sliq-import/detect.mjs';
describe('JNR SliQ data source risk guards', () => {
 it('reads a quoted comma in a customer name',()=>expect(parseCsv('Account,Name\nC01,"A, B Engineering"').rows[0][1]).toBe('A, B Engineering'));
 it('reads a doubled quote in a reference',()=>expect(parseCsv('Ref,Note\nI01,"Said ""paid"" today"').rows[0][1]).toBe('Said "paid" today'));
 it('refuses an unmatched quote',()=>expect(()=>parseCsv('Ref,Note\nI01,"missing')).toThrow(ParseError));
 it('refuses a row with too few cells rather than shifting invoice columns',()=>expect(()=>parseCsv('Ref,Amount,Customer\nINV1,50.00')).toThrow(/fields/));
 it('refuses a row with too many cells',()=>expect(()=>parseCsv('Ref,Amount\nINV1,50.00,EXTRA')).toThrow(/fields/));
 it('ignores whitespace-only blank rows',()=>expect(parseCsv('Ref,Amount\n\n  ,  \nINV1,1.00\n').rows).toEqual([['INV1','1.00']]));
 it('does not treat the header as a data record',()=>expect(parseCsv('Ref,Amount\nINV1,1.00').rows).toHaveLength(1));
 it('rejects no header',()=>expect(()=>parseCsv('\n,\n')).toThrow(/header/i));
 it('parses 29 pence exactly',()=>expect(parseMoneyPence('0.29')).toBe(29));
 it('rejects subpenny amounts',()=>expect(()=>parseMoneyPence('0.295')).toThrow());
 it('rejects invalid calendar dates',()=>expect(()=>parseDate('31/04/2026','DD/MM/YYYY')).toThrow(ParseError));
 it('recognises leap day only in leap years',()=>{expect(parseDate('29/02/2024','DD/MM/YYYY')).toBe('2024-02-29');expect(()=>parseDate('29/02/2026','DD/MM/YYYY')).toThrow()});
 it('does not silently choose UK ordering for an ambiguous date without a warning',()=>expect(detectDateFormat(['02/03/2026']).ambiguous).toBe(true));
 it('records mixed date formats as conflicts',()=>expect(detectDateFormat(['13.03.2026','14-03-2026']).conflict).toBeTruthy());
});
