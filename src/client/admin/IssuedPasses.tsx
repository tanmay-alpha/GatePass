import { Copy, Download, Printer, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventSummary, IssuedPass } from '../../shared/types';
import { toCsv } from '../csv';
import { errorMessage } from '../ui';
import { formatRangeInZone } from '../time';
import { adminQrUrl } from './http';

const MAX_CARDS = 60;
/** Printing renders one QR per pass; keep a sheet to a size browsers print reliably. */
const MAX_PRINT = 500;
const QR_CONCURRENCY = 6;

interface Props {
  event: EventSummary;
  passes: IssuedPass[];
  policyNames: Map<string, string>;
  onClose: () => void;
}

/** The short reference printed on passes and accepted by the scanner's manual entry. */
export function passReference(passId: string): string {
  return passId.slice(0, 8).toUpperCase();
}

/**
 * Shown once after issuance, import or reissue. Tokens are stored only as
 * hashes, so this is the last chance to download, print or copy links.
 */
export function IssuedPasses({ event, passes, policyNames, onClose }: Props) {
  const [printing, setPrinting] = useState(false);

  function downloadCsv() {
    const csv = toCsv([
      ['pass_id', 'reference', 'attendee_name', 'attendee_email', 'policy', 'expires_at', 'pass_url'],
      ...passes.map((pass) => [
        pass.id,
        passReference(pass.id),
        pass.attendeeName,
        pass.attendeeEmail,
        pass.policyId ? (policyNames.get(pass.policyId) ?? pass.policyId) : null,
        pass.expiresAt,
        pass.passUrl
      ])
    ]);
    // The BOM makes Excel read non-ASCII attendee names as UTF-8.
    download(`${slug(event.name)}-passes.csv`, URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })));
  }

  return (
    <section className="card issued" aria-labelledby="issued-title">
      <div className="section-head">
        <div className="section-title">
          <h2 id="issued-title">
            {passes.length} pass{passes.length === 1 ? '' : 'es'} ready
          </h2>
          <p className="warning-text small with-icon">
            <TriangleAlert size={14} aria-hidden /> Download, print or send these now. Codes cannot be shown again; use Reissue if one is lost.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary btn-small" onClick={downloadCsv}>
            <Download size={14} aria-hidden /> CSV of links
          </button>
          <button className="btn btn-secondary btn-small" onClick={() => setPrinting(true)} disabled={printing || passes.length > MAX_PRINT} title={passes.length > MAX_PRINT ? `Printing is limited to ${MAX_PRINT} passes at a time` : undefined}>
            <Printer size={14} aria-hidden /> {printing ? 'Preparing…' : 'Print passes'}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close issued passes" title="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      {printing ? <PrintSheet event={event} passes={passes} onDone={() => setPrinting(false)} /> : null}
      <ul className="issued-grid">
        {passes.slice(0, MAX_CARDS).map((pass) => (
          <IssuedCard key={pass.id} event={event} pass={pass} />
        ))}
      </ul>
      {passes.length > MAX_CARDS ? (
        <p className="muted small">
          Showing the first {MAX_CARDS} codes. All {passes.length} links are in the CSV{passes.length > MAX_PRINT ? '' : ' and the print view'}.
        </p>
      ) : null}
    </section>
  );
}

/** Renders every QR code, then opens the print dialog on a grid of cut-out passes (see `@media print`). */
function PrintSheet({ event, passes, onDone }: { event: EventSummary; passes: IssuedPass[]; onDone: () => void }) {
  const [urls, setUrls] = useState<Array<string | null> | null>(null);
  const [phase, setPhase] = useState<'rendering' | 'printing'>('rendering');
  const sheet = useRef<HTMLDivElement>(null);
  const failed = urls?.filter((url) => url === null).length ?? 0;
  const when = formatRangeInZone(event.startsAt, event.endsAt, event.timeZone);

  useEffect(() => {
    let live = true;
    const created: string[] = [];
    const result: Array<string | null> = passes.map(() => null);
    let next = 0;
    const worker = async () => {
      while (live && next < passes.length) {
        const index = next++;
        try {
          const url = await adminQrUrl(passes[index].passUrl, event.design);
          created.push(url);
          result[index] = url;
        } catch {
          result[index] = null;
        }
      }
    };
    void Promise.all(Array.from({ length: QR_CONCURRENCY }, worker)).then(() => live && setUrls(result));
    return () => {
      live = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [passes, event.design]);

  useEffect(() => {
    if (!urls || !sheet.current) return;
    let live = true;
    const images = [...sheet.current.querySelectorAll('img')];
    void Promise.allSettled(images.map((image) => image.decode())).then(() => {
      if (!live) return;
      setPhase('printing');
      window.print();
    });
    return () => {
      live = false;
    };
  }, [urls]);

  useEffect(() => {
    window.addEventListener('afterprint', onDone);
    return () => window.removeEventListener('afterprint', onDone);
  }, [onDone]);

  return (
    <>
      <div className="print-status" role="status">
        <span>
          {phase === 'rendering'
            ? `Preparing ${passes.length} pass${passes.length === 1 ? '' : 'es'} for printing…`
            : `Print dialog opened.${failed ? ` ${failed} code${failed === 1 ? '' : 's'} could not be rendered and are left blank.` : ''}`}
        </span>
        <button type="button" className="btn btn-ghost btn-small" onClick={onDone}>
          {phase === 'rendering' ? 'Cancel' : 'Close print view'}
        </button>
      </div>
      {urls
        ? createPortal(
            <div className="print-sheet" ref={sheet} aria-hidden>
              {passes.map((pass, index) => (
                <article key={pass.id} className="print-pass">
                  {urls[index] ? <img src={urls[index]} alt="" /> : <div className="print-missing">QR code unavailable: use the link from the CSV</div>}
                  <div className="print-name">{pass.attendeeName || 'Admission pass'}</div>
                  <div className="print-event">{event.name}</div>
                  <div className="print-when">{when}</div>
                  {event.venue ? <div className="print-when">{event.venue}</div> : null}
                  <div className="print-ref">
                    Ref <span>{passReference(pass.id)}</span>
                  </div>
                </article>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function IssuedCard({ event, pass }: { event: EventSummary; pass: IssuedPass }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const name = pass.attendeeName ?? 'unnamed attendee';

  useEffect(() => {
    let url = '';
    let live = true;
    adminQrUrl(pass.passUrl, event.design)
      .then((value) => {
        url = value;
        if (live) setSrc(value);
        else URL.revokeObjectURL(value);
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [pass.passUrl, event.design]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pass.passUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copying is blocked here; use the CSV of links.');
    }
  }

  async function downloadPng() {
    try {
      const url = await adminQrUrl(pass.passUrl, event.design, 'png');
      download(`${slug(pass.attendeeName ?? pass.id.slice(0, 8))}.png`, url);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <li className="issued-card">
      {src ? <img src={src} alt={`QR pass for ${name}`} /> : <div className="qr-placeholder">{error ? <span className="small">{error}</span> : null}</div>}
      <div className="issued-name">{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
      <code className="muted small">{passReference(pass.id)}</code>
      <div className="actions">
        <button className="btn btn-ghost btn-small" onClick={() => void copy()} aria-label={`Copy link for ${name}`}>
          <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Link'}
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => void downloadPng()} aria-label={`Download PNG for ${name}`}>
          <Download size={14} aria-hidden /> PNG
        </button>
      </div>
    </li>
  );
}

function download(filename: string, url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pass';
}
