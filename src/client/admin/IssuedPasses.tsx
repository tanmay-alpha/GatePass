import { Copy, Download, Printer, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EventSummary, IssuedPass } from '../../shared/types';
import { toCsv } from '../csv';
import { errorMessage } from '../ui';
import { BadgeSheet } from './BadgeSheet';
import { EmailIssuedPasses } from './DeliveriesSection';
import { adminQrUrl } from './http';

const MAX_CARDS = 60;
/** Printing renders one QR per pass; keep a sheet to a size browsers print reliably. */
const MAX_PRINT = 500;

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
          <EmailIssuedPasses eventId={event.id} passes={passes} />
          <button className="btn btn-secondary btn-small" onClick={downloadCsv}>
            <Download size={14} aria-hidden /> CSV of links
          </button>
          <button className="btn btn-secondary btn-small" onClick={() => setPrinting(true)} disabled={printing || passes.length > MAX_PRINT} title={passes.length > MAX_PRINT ? `Printing is limited to ${MAX_PRINT} passes at a time` : undefined}>
            <Printer size={14} aria-hidden /> Print passes
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close issued passes" title="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      {printing ? <BadgeSheet event={event} passes={passes} policyNames={policyNames} onDone={() => setPrinting(false)} /> : null}
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

function IssuedCard({ event, pass }: { event: EventSummary; pass: IssuedPass }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const name = pass.attendeeName ?? 'unnamed attendee';

  // Reloading the event gives `design` a new identity; refetch only when its content changes.
  const designKey = JSON.stringify(event.design);
  // The image keeps showing its URL until a new one replaces it, so a URL is revoked only once replaced or unmounted.
  const shown = useRef('');
  useEffect(() => () => URL.revokeObjectURL(shown.current), []);
  useEffect(() => {
    let live = true;
    setError('');
    adminQrUrl(pass.passUrl, JSON.parse(designKey))
      .then((value) => {
        if (!live) return URL.revokeObjectURL(value);
        URL.revokeObjectURL(shown.current);
        shown.current = value;
        setSrc(value);
      })
      .catch((err) => {
        if (!live) return;
        URL.revokeObjectURL(shown.current);
        shown.current = '';
        setSrc('');
        setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [pass.passUrl, designKey]);

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
