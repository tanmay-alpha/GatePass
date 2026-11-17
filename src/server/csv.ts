import type { Writable } from 'node:stream';

/**
 * Cells a spreadsheet would evaluate as a formula (OWASP "CSV Injection"): a
 * leading = + - @, tab or CR, and also a formula character after leading
 * whitespace (apps that trim cells on import, such as Google Sheets and
 * LibreOffice with "trim spaces", evaluate " =1+1") or in its full-width form
 * (＝ ＋ － ＠, which Excel accepts as formula prefixes under East Asian input).
 */
const FORMULA_START = /^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;
/**
 * Quoted: the RFC 4180 specials, plus `;`, the list separator Excel uses for
 * CSV in many European locales. Unquoted, `Bob;=1+1` would open there as two
 * cells, the second one a live formula.
 */
const NEEDS_QUOTES = /[",;\r\n]/;

/**
 * RFC 4180 CSV cell with spreadsheet formula-injection protection: a dangerous
 * cell is prefixed with `'` so spreadsheet software shows it as text.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as CSV text, each row ending in CRLF. */
export function csvRows(rows: unknown[][]): string {
  let text = '';
  for (const row of rows) text += `${row.map(csvCell).join(',')}\r\n`;
  return text;
}

/** Header row plus data rows, CRLF line endings, UTF-8 BOM so spreadsheet apps detect the encoding. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `\uFEFF${csvRows([header, ...rows])}`;
}

/**
 * Writes a CSV document chunk by chunk. `next()` returns the next rows (empty
 * when done) and must be synchronous and bounded, so one call holds the event
 * loop only briefly; between chunks the writer waits for the socket to drain
 * and yields to the event loop, so other requests (door redemptions above all)
 * are served while a large export is downloading. Stops as soon as the client
 * goes away. Resolves with the data rows written and whether the document is
 * complete; never rejects for a closed client.
 */
export async function streamCsv(out: Writable, header: string[], next: () => unknown[][]): Promise<{ rows: number; complete: boolean }> {
  let rows = 0;
  let text = toCsv(header, []);
  for (;;) {
    if (out.destroyed || out.writableEnded) return { rows, complete: false };
    if (!out.write(text)) await drainOrClose(out);
    if (out.destroyed) return { rows, complete: false };
    await new Promise<void>((resolve) => setImmediate(resolve));
    const chunk = next();
    if (!chunk.length) break;
    rows += chunk.length;
    text = csvRows(chunk);
  }
  if (out.destroyed) return { rows, complete: false };
  out.end();
  return { rows, complete: true };
}

function drainOrClose(out: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.on('drain', done);
    out.on('close', done);
  });
}
