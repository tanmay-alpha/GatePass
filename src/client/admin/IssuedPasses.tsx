import { Copy, Download, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EventSummary, IssuedPass } from '../../shared/types';
import { renderQrObjectUrl } from '../api';
import { toCsv } from '../csv';
import { errorMessage } from '../ui';

const MAX_CARDS = 60;

interface Props {
  token: string;
  event: EventSummary;
  passes: IssuedPass[];
  policyNames: Map<string, string>;
  onClose: () => void;
}

/**
 * Shown once after issuance or reissue. Tokens are stored only as hashes, so
 * this is the last chance to download codes or copy links.
 */
export function IssuedPasses({ token, event, passes, policyNames, onClose }: Props) {
  function downloadCsv() {
    const csv = toCsv([
      ['pass_id', 'attendee_name', 'attendee_email', 'policy', 'expires_at', 'pass_url'],
      ...passes.map((pass) => [pass.id, pass.attendeeName, pass.attendeeEmail, pass.policyId ? (policyNames.get(pass.policyId) ?? pass.policyId) : null, pass.expiresAt, pass.passUrl])
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
            <TriangleAlert size={14} aria-hidden /> Download or send these now. Codes cannot be shown again; use Reissue if one is lost.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary btn-small" onClick={downloadCsv}>
            <Download size={14} aria-hidden /> CSV of links
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close issued passes" title="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      <ul className="issued-grid">
        {passes.slice(0, MAX_CARDS).map((pass) => (
          <IssuedCard key={pass.id} token={token} event={event} pass={pass} />
        ))}
      </ul>
      {passes.length > MAX_CARDS ? (
        <p className="muted small">
          Showing the first {MAX_CARDS} codes. All {passes.length} links are in the CSV.
        </p>
      ) : null}
    </section>
  );
}

function IssuedCard({ token, event, pass }: { token: string; event: EventSummary; pass: IssuedPass }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const name = pass.attendeeName ?? 'unnamed attendee';

  useEffect(() => {
    let url = '';
    let live = true;
    renderQrObjectUrl(token, pass.passUrl, event.design)
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
  }, [token, pass.passUrl, event.design]);

  async function copy() {
    await navigator.clipboard.writeText(pass.passUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function downloadPng() {
    try {
      const url = await renderQrObjectUrl(token, pass.passUrl, event.design, 'png');
      download(`${slug(pass.attendeeName ?? pass.id.slice(0, 8))}.png`, url);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <li className="issued-card">
      {src ? <img src={src} alt={`QR pass for ${name}`} /> : <div className="qr-placeholder">{error ? <span className="small">{error}</span> : null}</div>}
      <div className="issued-name">{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
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
