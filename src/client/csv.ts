/** Characters that make spreadsheet apps treat a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralises formula injection by prefixing a single quote, then applies RFC 4180 quoting. */
export function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Serialises rows to CSV with CRLF line endings; every cell is quoted and formula-safe. */
export function toCsv(rows: (string | null)[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * The separator of the first record: comma (RFC 4180), or semicolon (spreadsheets
 * in comma-decimal locales) or tab (cells pasted from a spreadsheet) when the
 * first line contains more of those than commas. Quoted text is ignored.
 */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

/**
 * RFC 4180 parser: quoted fields may contain the delimiter, line breaks and
 * doubled quotes; records end with CRLF, LF or CR; a leading UTF-8 BOM is
 * dropped. Records whose cells are all blank are skipped.
 */
export function parseCsv(input: string, delimiter = detectDelimiter(input.replace(/^\uFEFF/, ''))): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endRecord = () => {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
    cell = '';
  };

  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += char;
      i++;
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      // Opening quote; whitespace before it is not part of the value.
      cell = '';
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      endRecord();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else cell += char;
    i++;
  }
  if (cell !== '' || row.length) endRecord();
  return rows;
}

export interface AttendeeRow {
  name: string | null;
  email: string | null;
}

export interface ParsedAttendees {
  rows: AttendeeRow[];
  /** The first record named the columns and was not imported. */
  hasHeader: boolean;
  /** Column headings found, for the preview ("Name", "Email"). */
  columns: { name: string | null; email: string | null };
}

const NAME_HEADERS = ['name', 'fullname', 'attendee', 'attendeename', 'guest', 'guestname', 'participant', 'participantname'];
const FIRST_HEADERS = ['firstname', 'givenname', 'first', 'forename'];
const LAST_HEADERS = ['lastname', 'surname', 'familyname', 'last'];
const EMAIL_HEADERS = ['email', 'emailaddress', 'mail', 'attendeeemail', 'guestemail'];

const normaliseHeader = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');

const clean = (value: string | undefined) => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

/**
 * Maps CSV records to attendees. A first record with a name or email heading
 * ("Name", "Full name", "First name" + "Last name", "Email", "E-mail address")
 * is treated as the header and its columns are used. Without one, the first
 * column is the name and the second the email, unless the first column is the
 * one containing "@" (then it is the email and the second, if any, the name).
 */
export function attendeesFromCsv(records: string[][]): ParsedAttendees {
  const header = records[0]?.map(normaliseHeader) ?? [];
  const find = (names: string[]) => header.findIndex((value) => names.includes(value));
  const nameColumn = find(NAME_HEADERS);
  const firstColumn = find(FIRST_HEADERS);
  const lastColumn = find(LAST_HEADERS);
  const emailColumn = find(EMAIL_HEADERS);
  const hasHeader = nameColumn >= 0 || firstColumn >= 0 || lastColumn >= 0 || emailColumn >= 0;

  if (!hasHeader) {
    return {
      hasHeader: false,
      columns: { name: null, email: null },
      rows: records.map((record) => {
        const first = clean(record[0]);
        const second = clean(record[1]);
        if (first?.includes('@') && !second?.includes('@')) return { name: second, email: first };
        return { name: first, email: second };
      })
    };
  }

  const label = (index: number) => (index >= 0 ? records[0][index].trim() : null);
  return {
    hasHeader: true,
    columns: {
      name: nameColumn >= 0 ? label(nameColumn) : [label(firstColumn), label(lastColumn)].filter(Boolean).join(' + ') || null,
      email: label(emailColumn)
    },
    rows: records.slice(1).map((record) => {
      const name = nameColumn >= 0 ? clean(record[nameColumn]) : clean([firstColumn, lastColumn].map((index) => (index >= 0 ? (record[index] ?? '').trim() : '')).filter(Boolean).join(' '));
      return { name, email: emailColumn >= 0 ? clean(record[emailColumn]) : null };
    })
  };
}
