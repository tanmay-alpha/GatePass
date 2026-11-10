/**
 * RFC 4180 CSV with spreadsheet formula-injection protection (OWASP "CSV
 * Injection"): a cell starting with = + - @ tab or CR is prefixed with `'`
 * so spreadsheet software shows it as text instead of evaluating it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header row plus data rows, CRLF line endings, UTF-8 BOM so spreadsheet apps detect the encoding. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
