import { useEffect, useState } from 'react';
import { defaultDesignConfig, logoGallery, templates } from '../../qr/design';
import type { DesignConfig, EventSummary } from '../../shared/types';
import { createQrDetector } from '../qr-detector';
import { ErrorNote, SectionHead, errorMessage } from '../ui';
import { adminApi, adminQrUrl } from './http';
import { ARCHIVED_NOTE, can } from './model';
import { useToast } from './toast';

// Same length and character set as a real pass URL, so the scan check is representative.
const SAMPLE_URL = `${window.location.origin}/p/${'x'.repeat(43)}`;

type ScanCheck = 'checking' | 'ok' | 'fail';

/**
 * Per-event pass styling using the upstream QR renderer. Every preview is
 * decoded with the same detector the door scanner uses, so a design that
 * hurts readability is flagged before passes go out.
 */
export function DesignPanel({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const editable = can(event, 'edit') && event.status !== 'archived';
  const [design, setDesign] = useState<DesignConfig>(event.design);
  const [preview, setPreview] = useState('');
  const [check, setCheck] = useState<ScanCheck>('checking');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const notify = useToast();

  useEffect(() => {
    let live = true;
    let url = '';
    setCheck('checking');
    (async () => {
      try {
        url = await adminQrUrl(SAMPLE_URL, design);
        if (!live) return URL.revokeObjectURL(url);
        setPreview(url);
        const image = new Image();
        image.src = url;
        await image.decode();
        const detector = await createQrDetector();
        const found = await detector.detect(image);
        if (live) setCheck(found === SAMPLE_URL ? 'ok' : 'fail');
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
    setDirty(true);
    setError('');
    setDesign((current) => ({ ...current, ...patch }));
  }

  function setInk(color: string) {
    update({ bodyColor: color, eye1Color: color, eye2Color: color, eye3Color: color, eyeBall1Color: color, eyeBall2Color: color, eyeBall3Color: color });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await adminApi(`/api/events/${event.id}`, { method: 'PATCH', body: { design } });
      await onChanged();
      setDirty(false);
      notify('Design saved. New and reissued passes use it.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" aria-labelledby="design-title">
      <SectionHead
        id="design-title"
        title="Pass design"
        description={
          editable
            ? 'Applies to passes issued or reissued after saving. Every preview is checked with the same decoder the door scanner uses.'
            : event.status === 'archived'
              ? ARCHIVED_NOTE
              : 'You can preview the design but not change it.'
        }
      />
      <div className="design">
        <div className="design-preview">
          {preview ? <img src={preview} alt="Pass QR preview" /> : <div className="qr-placeholder" />}
          <p className={`scan-check scan-check-${check}`} role="status">
            {check === 'checking' ? 'Checking readability…' : check === 'ok' ? 'Scan check passed' : 'Scan check failed: increase contrast or remove the logo'}
          </p>
        </div>
        <fieldset className="form-grid" disabled={!editable}>
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
          {editable ? (
            <div className="actions span-2">
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty || check !== 'ok'}>
                {saving ? 'Saving…' : 'Save design'}
              </button>
              <button className="btn btn-secondary" onClick={() => update({ ...defaultDesignConfig })}>
                Reset
              </button>
              {dirty ? <span className="muted small">Unsaved changes</span> : null}
            </div>
          ) : null}
        </fieldset>
      </div>
    </section>
  );
}
