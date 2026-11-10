import { describe, expect, it } from 'vitest';
import { attendeesFromCsv, parseCsv, toCsv } from '../src/client/csv';

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

describe('RFC 4180 parsing', () => {
  it('handles quoted delimiters, escaped quotes and line breaks inside quotes', () => {
    expect(parseCsv('"Lovelace, Ada",ada@example.com\r\n"Say ""hi""","multi\nline"\r\n')).toEqual([
      ['Lovelace, Ada', 'ada@example.com'],
      ['Say "hi"', 'multi\nline']
    ]);
  });

  it('accepts CRLF, LF and CR record endings, a BOM and a missing final newline', () => {
    expect(parseCsv('\uFEFFa,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h']
    ]);
  });

  it('keeps empty fields and skips blank records', () => {
    expect(parseCsv('a,,c\n\n,,\r\n,b\n')).toEqual([
      ['a', '', 'c'],
      ['', 'b']
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('round-trips its own output', () => {
    const rows = [
      ['Name', 'Email'],
      ['O\'Brien, "Pat"', 'pat@example.com'],
      ['Line\r\nbreak', '']
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('detects semicolon and tab separated input', () => {
    expect(parseCsv('Name;Email\n"Doe; Jane";jane@example.com')).toEqual([
      ['Name', 'Email'],
      ['Doe; Jane', 'jane@example.com']
    ]);
    expect(parseCsv('Ada\tada@example.com\nGrace\t')).toEqual([
      ['Ada', 'ada@example.com'],
      ['Grace', '']
    ]);
  });
});

describe('attendee mapping', () => {
  it('uses a header row in any column order and case', () => {
    const parsed = attendeesFromCsv(parseCsv('E-mail Address,Ticket,Full Name\nada@example.com,VIP,Ada Lovelace\n,GA,Grace Hopper'));
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.columns).toEqual({ name: 'Full Name', email: 'E-mail Address' });
    expect(parsed.rows).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
      { name: 'Grace Hopper', email: null }
    ]);
  });

  it('joins first and last name columns', () => {
    const parsed = attendeesFromCsv(parseCsv('First name,Last name,Email\nAda,Lovelace,ada@example.com\nGrace,,'));
    expect(parsed.columns.name).toBe('First name + Last name');
    expect(parsed.rows).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
      { name: 'Grace', email: null }
    ]);
  });

  it('without a header reads name then email, and recognises an email-only or email-first row', () => {
    const parsed = attendeesFromCsv(parseCsv('"Lovelace, Ada", ada@example.com\nGrace Hopper\nalan@example.com\nkatherine@example.com,Katherine Johnson'));
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.rows).toEqual([
      { name: 'Lovelace, Ada', email: 'ada@example.com' },
      { name: 'Grace Hopper', email: null },
      { name: null, email: 'alan@example.com' },
      { name: 'Katherine Johnson', email: 'katherine@example.com' }
    ]);
  });
});
