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
