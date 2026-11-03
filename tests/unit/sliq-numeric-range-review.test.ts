import { expect,it } from 'vitest';
import { parseQuantityMilli,parsePercentCenti } from '../../scripts/sliq-import/parse.mjs';
it.each(['9007199254740.992','-9007199254740.992','9'.repeat(400)])('rejects quantity outside exact integer range: %s',value=>expect(()=>parseQuantityMilli(value)).toThrow(/too large/));
it.each(['90071992547409.92','9'.repeat(400)])('rejects percentage outside exact integer range: %s',value=>expect(()=>parsePercentCenti(value)).toThrow(/too large/));
it('preserves the exact quantity boundary, sign and ordinary thousandths',()=>{
 expect(parseQuantityMilli('9007199254740.991')).toBe(Number.MAX_SAFE_INTEGER);
 expect(parseQuantityMilli('-9007199254740.991')).toBe(-Number.MAX_SAFE_INTEGER);
 expect(parseQuantityMilli('12.345')).toBe(12345);
});
it('preserves exact percentage boundary and ordinary hundredths',()=>{
 expect(parsePercentCenti('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
 expect(parsePercentCenti('17.50%')).toBe(1750);
});
