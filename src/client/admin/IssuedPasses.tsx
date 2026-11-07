import { Copy, Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EventSummary, IssuedPass } from '../../shared/types';
import { renderQrObjectUrl } from '../api';

/**
 * Shown once after issuance or reissue. Tokens are stored only as hashes, so
 * this is the last chance to download codes or copy links.
 */
export function IssuedPasses({ event, passes, onClose }: { event: EventSummary; passes: IssuedPass[]; onClose: () => void }) {
  function downloadCsv() {
    const escape = (value: string | null) => `"${(value ?? '').replace(/"/g, '""')}"`;
    const rows = [['pass_id', 'attendee_name', 'attendee_email', 'expires_at', 'pass_url'].join(',')];
    for (const pass of passes) rows.push([pass.id, pass.attendeeName, pass.attendeeEmail, pass.expiresAt, pass.passUrl].map(escape).join(','));
    download(`${slug(event.name)}-passes.csv`, URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })));
  }

  return (
    <div className="issued" role="region" aria-label="Newly issued passes">
      <div className="issued-head">
        <div>
          <h3>
            {passes.length} pass{passes.length === 1 ? '' : 'es'} ready
          </h3>
          <p className="warning-text">Download or send these now. Codes cannot be shown again; use Reissue if one is lost.</p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary btn-small" onClick={downloadCsv}>
            <Download size={14} aria-hidden /> CSV of links
          </button>
          <button className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      <ul className="issued-grid">
        {passes.slice(0, 60).map((pass) => (
          <IssuedCard key={pass.id} event={event} pass={pass} />
        ))}
      </ul>
      {passes.length > 60 ? <p className="muted small">Showing the first 60 codes. All {passes.length} links are in the CSV.</p> : null}
    </div>
  );
}

function IssuedCard({ event, pass }: { event: EventSummary; pass: IssuedPass }) {
  const [src, setSrc] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let url = '';
    let live = true;
    void renderQrObjectUrl(pass.passUrl, event.design).then((value) => {
      url = value;
      if (live) setSrc(value);
      else URL.revokeObjectURL(value);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [pass.passUrl, event.design]);

  async function copy() {
    await navigator.clipboard.writeText(pass.passUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function downloadPng() {
    const url = await renderQrObjectUrl(pass.passUrl, event.design, 'png');
    download(`${slug(pass.attendeeName ?? pass.id.slice(0, 8))}.png`, url);
  }

  return (
    <li className="issued-card">
      {src ? <img src={src} alt={`QR pass for ${pass.attendeeName ?? 'unnamed attendee'}`} /> : <div className="qr-placeholder" />}
      <div className="issued-name">{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
      <div className="actions">
        <button className="btn btn-ghost btn-small" onClick={() => void copy()}>
          <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Link'}
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => void downloadPng()}>
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
