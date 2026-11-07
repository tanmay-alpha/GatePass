import { useEffect, useState } from 'react';
import { defaultDesignConfig, logoGallery, templates } from '../../qr/design';
import type { DesignConfig, EventSummary } from '../../shared/types';
import { api, renderQrObjectUrl } from '../api';
import { createQrDetector } from '../qr-detector';
import { ErrorNote, errorMessage } from '../ui';

// Same length and character set as a real pass URL, so the scan check is representative.
const SAMPLE_URL = `${window.location.origin}/p/${'x'.repeat(43)}`;

type ScanCheck = 'checking' | 'ok' | 'fail';

/**
 * Per-event pass styling using the upstream QR renderer. Every preview is
 * decoded with the same detector the door scanner uses, so a design that
 * hurts readability is flagged before passes go out.
 */
export function DesignPanel({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [design, setDesign] = useState<DesignConfig>(event.design);
  const [preview, setPreview] = useState('');
  const [check, setCheck] = useState<ScanCheck>('checking');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    let url = '';
    setCheck('checking');
    (async () => {
      try {
        url = await renderQrObjectUrl(SAMPLE_URL, design);
        if (!live) return URL.revokeObjectURL(url);
        setPreview(url);
        const image = new Image();
        image.src = url;
        await image.decode();
        const detector = await createQrDetector();
        const found = await detector.detect(image);
        if (live) setCheck(found.some((code) => code.rawValue === SAMPLE_URL) ? 'ok' : 'fail');
      } catch (err) {
        if (live) {
          setCheck('fail');
          setError(errorMessage(err));
        }
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [design]);

  function update(patch: Partial<DesignConfig>) {
    setSaved(false);
    setError('');
    setDesign((current) => ({ ...current, ...patch }));
  }

  function setInk(color: string) {
    update({ bodyColor: color, eye1Color: color, eye2Color: color, eye3Color: color, eyeBall1Color: color, eyeBall2Color: color, eyeBall3Color: color });
  }

  async function save() {
    try {
      await api(`/api/events/${event.id}`, token, { method: 'PATCH', body: { design } });
      await onChanged();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="design">
      <div className="design-preview">
        {preview ? <img src={preview} alt="Pass QR preview" /> : <div className="qr-placeholder" />}
        <p className={`scan-check scan-check-${check}`} role="status">
          {check === 'checking' ? 'Checking readability…' : check === 'ok' ? 'Scan check passed' : 'Scan check failed: increase contrast or remove the logo'}
        </p>
      </div>
      <div className="form-grid">
        <label className="span-2">
          Template
          <select
            value=""
            onChange={(e) => {
              const template = templates.find((item) => item.name === e.target.value);
              if (template) update({ ...template.config });
            }}
          >
            <option value="">Apply a template…</option>
            {templates.map((template) => (
              <option key={template.name}>{template.name}</option>
            ))}
          </select>
        </label>
        <label>
          Code colour
          <input type="color" value={design.bodyColor} onChange={(e) => setInk(e.target.value)} />
        </label>
        <label>
          Background
          <input type="color" value={design.bgColor} onChange={(e) => update({ bgColor: e.target.value })} />
        </label>
        <label className="span-2">
          Centre logo
          <select value={design.logo ?? ''} onChange={(e) => update({ logo: e.target.value || null, logoMode: 'clean' })}>
            <option value="">None</option>
            {logoGallery.map((name) => (
              <option key={name} value={`#${name}`}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <ErrorNote message={error} />
        <div className="actions span-2">
          <button className="btn btn-primary" onClick={() => void save()} disabled={check === 'fail'}>
            Save design
          </button>
          <button className="btn btn-secondary" onClick={() => update({ ...defaultDesignConfig })}>
            Reset
          </button>
          {saved ? <span className="muted small">Saved. New and reissued passes use this design.</span> : null}
        </div>
      </div>
    </div>
  );
}
