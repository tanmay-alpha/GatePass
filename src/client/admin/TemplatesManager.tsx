import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { EventTemplate } from '../../shared/types';
import { useConfirm } from '../dialog';
import { ErrorNote, SectionHead, errorMessage, formatShortDateTime } from '../ui';
import { useResource } from './hooks';
import { adminApi } from './http';
import { TEMPLATES_PATH, TemplateOutline } from './TemplatePicker';
import { useToast } from './toast';
import './templates.css';

/** The account's own saved templates, with delete. Hidden until the first template is saved. */
export function TemplatesManager() {
  const { data, error, reload } = useResource<EventTemplate[]>(TEMPLATES_PATH);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const saved = data?.filter((template) => template.kind === 'saved') ?? [];

  async function remove(template: EventTemplate) {
    const ok = await confirm({
      title: `Delete “${template.name}”?`,
      body: 'Events already created from it are not affected.',
      confirmLabel: 'Delete template',
      danger: true
    });
    if (!ok) return;
    setBusy(template.id);
    setActionError('');
    try {
      await adminApi(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
      await reload();
      notify(`Template “${template.name}” deleted`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!saved.length) return error ? <ErrorNote message={`Your templates could not be loaded: ${error}`} /> : null;
  return (
    <section className="card" aria-labelledby="templates-title">
      <SectionHead id="templates-title" title="Your templates" description="Saved from an event's Settings tab. Pick one under “Start from” when you create an event. Only you can see them." />
      <ErrorNote message={actionError || error} />
      <ul className="template-list">
        {saved.map((template) => (
          <li key={template.id} className="template-item">
            <div className="template-item-head">
              <div className="template-item-title">
                <span className="strong">{template.name}</span>
                <span className="muted small">
                  {template.description ? `${template.description} · ` : ''}saved {formatShortDateTime(template.createdAt)}
                </span>
              </div>
              <button type="button" className="btn btn-secondary btn-small danger" onClick={() => void remove(template)} disabled={busy !== null}>
                <Trash2 size={14} aria-hidden /> {busy === template.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
            <TemplateOutline config={template.config} />
          </li>
        ))}
      </ul>
      {dialog}
    </section>
  );
}
