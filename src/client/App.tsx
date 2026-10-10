import { Archive, Download, ImagePlus, Link2, Palette, QrCode, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { bodyShapes, defaultDesignConfig, eyeBalls, eyeFrames, logoGallery, templates } from '../qr/design';
import { getLogoIcon } from '../qr/logo-icons';
import { buildPayload } from '../qr/payloads';
import type { ContentType, DesignConfig, QrMode, QrRecord } from '../shared/types';
import { sampleContent } from './sample-content';

const contentTypes: ContentType[] = ['url', 'text', 'email', 'phone', 'sms', 'vcard', 'mecard', 'maps', 'facebook', 'twitter', 'youtube', 'wifi', 'event', 'crypto'];
const moreTypes: ContentType[] = ['mp3', 'video', 'pdf', 'social', 'app', 'gallery', 'rating', 'feedback'];

const defaults: Record<ContentType, Record<string, unknown>> = sampleContent;

export function App() {
  const [type, setType] = useState<ContentType>('url');
  const [mode, setMode] = useState<QrMode>('static');
  const [name, setName] = useState('Campaign QR');
  const [payload, setPayload] = useState<Record<string, unknown>>(defaults.url);
  const [design, setDesign] = useState<DesignConfig>(defaultDesignConfig);
  const [size, setSize] = useState(300);
  const [keyword, setKeyword] = useState('');
  const [preview, setPreview] = useState('');
  const [downloadData, setDownloadData] = useState('https://example.com');
  const [error, setError] = useState('');
  const [records, setRecords] = useState<QrRecord[]>([]);
  const [selected, setSelected] = useState<QrRecord | null>(null);

  const encodedPayload = useMemo(() => JSON.stringify(payload, null, 2), [payload]);

  useEffect(() => {
    setPayload(defaults[type]);
    if (moreTypes.includes(type)) setMode('dynamic_payload');
  }, [type]);

  useEffect(() => {
    void refreshPreview();
  }, [payload, design, size]);

  useEffect(() => {
    void loadRecords();
  }, []);

  async function refreshPreview() {
    try {
      setError('');
      const data = await buildPreviewPayload(type, payload);
      setDownloadData(data);
      const response = await fetch('/api/qr/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, size, file: 'svg', config: design })
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Preview failed');
      setPreview(URL.createObjectURL(await response.blob()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    }
  }

  async function saveQr() {
    const response = await fetch('/api/qr-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode, contentType: type, contentPayload: payload, designConfig: design, sizePx: size, keyword: keyword || undefined })
    });
    if (!response.ok) {
      setError((await response.json()).error || 'Save failed');
      return;
    }
    const qr = (await response.json()) as QrRecord;
    setSelected(qr);
    await loadRecords();
  }

  async function loadRecords() {
    const response = await fetch('/api/qr-codes');
    if (response.ok) setRecords(await response.json());
  }

  async function uploadLogo(file?: File) {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    const response = await fetch('/api/qr/upload-image', { method: 'POST', body: form });
    if (!response.ok) {
      setError((await response.json()).error || 'Upload failed');
      return;
    }
    const result = await response.json();
    setDesign({ ...design, logo: result.file });
  }

  return (
    <main className="app-shell">
      {/* Theme strip — empty container; theme-toggle.ts mounts the buttons */}
      <div className="theme-strip">
        <div className="theme-strip-inner" />
      </div>

      <section className="workspace">
        <header className="topbar">
          <div className="brand">
            <p className="eyebrow">QR CODE TOOLKIT · YOURLS</p>
            <h1 className="brand-name">QR Code <em>Toolkit</em></h1>
          </div>
          <div className="status">
            <ShieldCheck size={16} aria-hidden />
            <span>Self-hosted QR generator</span>
          </div>
        </header>

        <nav className="type-strip" aria-label="Content type">
          {[...contentTypes, ...moreTypes].map((item) => (
            <button key={item} className={type === item ? 'chip active' : 'chip'} onClick={() => setType(item)}>
              {item}
            </button>
          ))}
        </nav>

        <section className="editor-grid">
          <div className="editor">
            <Panel eyebrow="CONTENT" title="Payload" icon={<Link2 size={16} aria-hidden />}>
              <div className="row">
                <label className="field">
                  <span className="field-label">Name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Mode</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as QrMode)} disabled={moreTypes.includes(type)}>
                    <option value="static">Static</option>
                    <option value="dynamic_url">Dynamic URL</option>
                    <option value="dynamic_payload">Dynamic payload</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">YOURLS keyword</span>
                  <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="optional" disabled={mode === 'static'} />
                </label>
              </div>
              <PayloadEditor type={type} payload={payload} setPayload={setPayload} />
              <details>
                <summary>Payload JSON</summary>
                <textarea value={encodedPayload} onChange={(event) => safeJson(event.target.value, setPayload, setError)} />
              </details>
            </Panel>

            <Panel eyebrow="COLORS" title="Palette" icon={<Palette size={16} aria-hidden />}>
              <div className="row dense">
                <Color label="Foreground" value={design.bodyColor} onChange={(bodyColor) => setDesign({ ...design, bodyColor })} />
                <Color label="Background" value={design.bgColor} onChange={(bgColor) => setDesign({ ...design, bgColor })} />
                <Color label="Eye" value={design.eye1Color} onChange={(eye1Color) => setDesign({ ...design, eye1Color, eye2Color: eye1Color, eye3Color: eye1Color })} />
                <Color label="Eye ball" value={design.eyeBall1Color} onChange={(eyeBall1Color) => setDesign({ ...design, eyeBall1Color, eyeBall2Color: eyeBall1Color, eyeBall3Color: eyeBall1Color })} />
              </div>
              <div className="row">
                <Color label="Gradient 1" value={design.gradientColor1 || '#000000'} onChange={(gradientColor1) => setDesign({ ...design, gradientColor1 })} />
                <Color label="Gradient 2" value={design.gradientColor2 || '#333333'} onChange={(gradientColor2) => setDesign({ ...design, gradientColor2 })} />
                <label className="field">
                  <span className="field-label">Gradient type</span>
                  <select value={design.gradientType} onChange={(event) => setDesign({ ...design, gradientType: event.target.value as 'linear' | 'radial' })}>
                    <option value="linear">Linear</option>
                    <option value="radial">Radial</option>
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={design.gradientOnEyes} onChange={(event) => setDesign({ ...design, gradientOnEyes: event.target.checked })} />
                  <span>Gradient on eyes</span>
                </label>
              </div>
            </Panel>

            <Panel eyebrow="LOGO &amp; DESIGN" title="Marks &amp; geometry" icon={<ImagePlus size={16} aria-hidden />}>
              <div className="row">
                <label className="field">
                  <span className="field-label">Upload logo</span>
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" onChange={(event) => uploadLogo(event.target.files?.[0])} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={design.logoMode === 'clean'} onChange={(event) => setDesign({ ...design, logoMode: event.target.checked ? 'clean' : 'default' })} />
                  <span>Remove background behind logo</span>
                </label>
                <button className="btn btn-secondary" onClick={() => setDesign({ ...design, logo: null })}>Remove logo</button>
              </div>
              <div className="shape-list">
                {logoGallery.map((logo) => (
                  <LogoPresetButton
                    key={logo}
                    name={logo}
                    active={design.logo === `#${logo}`}
                    onClick={() => setDesign({ ...design, logo: `#${logo}` })}
                  />
                ))}
              </div>
              <div className="row">
                <label className="field">
                  <span className="field-label">Body</span>
                  <select value={design.body} onChange={(event) => setDesign({ ...design, body: event.target.value })}>
                    {bodyShapes.map((shape) => <option key={shape}>{shape}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Eye frame</span>
                  <select value={design.eye} onChange={(event) => setDesign({ ...design, eye: event.target.value })}>
                    {eyeFrames.map((shape) => <option key={shape}>{shape}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Eye ball</span>
                  <select value={design.eyeBall} onChange={(event) => setDesign({ ...design, eyeBall: event.target.value })}>
                    {eyeBalls.map((shape) => <option key={shape}>{shape}</option>)}
                  </select>
                </label>
              </div>
            </Panel>

            <Panel eyebrow="TEMPLATES" title="Presets" icon={<QrCode size={16} aria-hidden />}>
              <div className="template-list">
                {templates.map((template) => (
                  <button key={template.name} className="chip" onClick={() => setDesign(template.config)}>{template.name}</button>
                ))}
              </div>
            </Panel>
          </div>

          <aside className="preview-pane">
            <p className="eyebrow">PREVIEW</p>
            <div className="preview-box">
              {preview ? <img src={preview} alt="QR preview" /> : <QrCode size={140} aria-hidden />}
            </div>
            <label className="field">
              <span className="field-label">Size · {size}px</span>
              <input type="range" min="200" max="2000" step="25" value={size} onChange={(event) => setSize(Number(event.target.value))} />
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="actions">
              <button className="btn btn-secondary" onClick={refreshPreview}><RefreshCw size={14} aria-hidden /> Preview</button>
              <button className="btn btn-primary" onClick={saveQr}><Save size={14} aria-hidden /> Save</button>
              <a className="btn btn-secondary" href={`/api/qr/custom?data=${encodeURIComponent(downloadData)}&size=${size}&file=png&download=true&config=${encodeURIComponent(JSON.stringify(design))}`}><Download size={14} aria-hidden /> PNG</a>
              {selected && <a className="btn btn-secondary" href={`/api/qr-codes/${selected.id}/render?file=svg`}><Download size={14} aria-hidden /> SVG</a>}
            </div>
            <p className="note">PDF and EPS are intentionally disabled in this MVP — print renderer is the next phase.</p>
          </aside>
        </section>
      </section>

      <section className="management" aria-label="Saved artifacts">
        <p className="eyebrow">SAVED ARTIFACTS</p>
        <h2><Archive size={18} aria-hidden /> Saved QR codes</h2>
        <div className="records">
          {records.map((record) => (
            <button key={record.id} className={selected?.id === record.id ? 'record active' : 'record'} onClick={() => setSelected(record)}>
              <span className="record-name">{record.name}</span>
              <small className="record-meta">{record.contentType} · {record.mode}</small>
              <small className="record-payload">{record.yourlsShortUrl || record.encodedPayload.slice(0, 60)}</small>
            </button>
          ))}
        </div>
        {selected && <SelectedRecord record={selected} reload={loadRecords} />}
      </section>
    </main>
  );
}

function Panel({ eyebrow, title, icon, children }: { eyebrow: string; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{icon}{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LogoPresetButton({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  const icon = getLogoIcon(name);
  return (
    <button
      className={active ? 'logo-preset active' : 'logo-preset'}
      onClick={onClick}
      aria-pressed={active}
      title={name}
      type="button"
    >
      {icon ? (
        <svg viewBox="0 0 100 100" aria-hidden className="logo-preset-icon">
          <circle cx="50" cy="50" r="49" fill={icon.bg} />
          <g fill={icon.fg} dangerouslySetInnerHTML={{ __html: icon.body }} />
        </svg>
      ) : (
        <span className="logo-preset-fallback">{name.slice(0, 2).toUpperCase()}</span>
      )}
      <span>{name}</span>
    </button>
  );
}

function PayloadEditor({ type, payload, setPayload }: { type: ContentType; payload: Record<string, unknown>; setPayload: (payload: Record<string, unknown>) => void }) {
  const keys = Object.keys(payload);
  return (
    <div className="payload-fields">
      {keys.map((key) => (
        <label key={key} className="field">
          <span className="field-label">{key}</span>
          <input
            value={typeof payload[key] === 'object' ? JSON.stringify(payload[key]) : String(payload[key] ?? '')}
            onChange={(event) => {
              const raw = event.target.value;
              const next = { ...payload, [key]: parseFieldValue(raw) };
              setPayload(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

function SelectedRecord({ record, reload }: { record: QrRecord; reload: () => Promise<void> }) {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void fetch(`/api/qr-codes/${record.id}/stats`).then((r) => r.json()).then(setStats);
  }, [record.id]);
  return (
    <div className="selected">
      <p className="eyebrow">RECORD</p>
      <h3>{record.name}</h3>
      <img src={`/api/qr-codes/${record.id}/render?file=svg`} alt="" />
      <dl>
        <dt>Short URL</dt><dd>{record.yourlsShortUrl || 'Static QR'}</dd>
        <dt>Encoded payload</dt><dd>{record.encodedPayload}</dd>
        <dt>Stats</dt><dd>{JSON.stringify(stats)}</dd>
      </dl>
      <button className="btn btn-secondary" onClick={reload}>Refresh list</button>
    </div>
  );
}

async function buildPreviewPayload(type: ContentType, payload: Record<string, unknown>) {
  return buildPayload(type, payload);
}

function safeJson(value: string, setPayload: (payload: Record<string, unknown>) => void, setError: (error: string) => void) {
  try {
    setPayload(JSON.parse(value));
    setError('');
  } catch {
    setError('Payload JSON is invalid');
  }
}

function parseFieldValue(value: string): unknown {
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
