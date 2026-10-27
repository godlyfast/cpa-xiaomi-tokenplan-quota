import { expect, test } from 'bun:test';
import { credit, balance } from '../src/credit';

test('exact fractional and huge string Credits never round through Number', () => {
  expect(balance('9007199254740993.25', '9007199254740994.5')).toEqual({
    used: '9007199254740993.25', limit: '9007199254740994.5', remaining: '1.25', remainingPercent: '0.00'
  });
  expect(balance('1.25', '10')).toEqual({used:'1.25',limit:'10',remaining:'8.75',remainingPercent:'87.50'});
});
test('zero limits have no percentage; exhausted balance is not negative', () => {
  expect(balance(0,0)).toEqual({used:'0',limit:'0',remaining:'0',remainingPercent:null});
  expect(balance(11,10).remaining).toBe('0');
  expect(balance(11,10).remainingPercent).toBe('0.00');
});
test('reject missing, negative, unsafe, exponential and fractional numeric counters', () => {
  for (const v of [undefined, null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER+1, 0.1, '1e9', '-1', '', {}, '1.2.3']) expect(() => credit(v)).toThrow();
  expect(credit('0001.2500')).toBe('1.25');
});
