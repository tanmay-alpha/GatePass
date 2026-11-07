import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/client/csv';

describe('attendee CSV export', () => {
  it('neutralises spreadsheet formulas in attendee-controlled cells', () => {
    const csv = toCsv([['=HYPERLINK("https://evil.example","x")', '+1', '-2', '@SUM(A1)', '\tTab', '\rCR', 'Ada']]);
    expect(csv).toBe(`"'=HYPERLINK(""https://evil.example"",""x"")","'+1","'-2","'@SUM(A1)","'\tTab","'\rCR","Ada"`);
  });

  it('quotes commas, quotes and newlines and maps null to empty', () => {
    expect(toCsv([['a,b', 'say "hi"', 'line\nbreak', null]])).toBe('"a,b","say ""hi""","line\nbreak",""');
    expect(toCsv([['a'], ['b']])).toBe('"a"\r\n"b"');
  });
});
