import { BookmarkPlus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { EventSummary, EventTemplate } from '../../shared/types';
import { ErrorNote, FieldError, SectionHead, errorMessage, focusFirstInvalid } from '../ui';
import { adminApi } from './http';
import { useToast } from './toast';
import './templates.css';

/** Saves this event's settings, gates and policy shapes as a private template of the signed-in account. */
export function SaveTemplateSection({ event }: { event: EventSummary }) {
  const [name, setName] = useState(event.name.slice(0, 100));
  const [description, setDescription] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const id = useId();
  const nameError = showErrors && !name.trim() ? 'Enter a name for the template.' : undefined;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const saved = await adminApi<EventTemplate>(`/api/events/${event.id}/save-template`, { body: { name: name.trim(), description: description.trim() || null } });
      setShowErrors(false);
      notify(`Template “${saved.name}” saved. Pick it when you create a new event.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <SectionHead
        id={`${id}-title`}
        title="Save as template"
        description="Keeps the venue, time zone, length, capacity, pass design, gates and policies (entry windows relative to the start) for your next event. Passes, attendees, devices and the team are never saved. Only you can see your templates."
      />
      <form className="form-grid" onSubmit={submit} noValidate>
        <label className="span-2">
          Template name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-invalid={nameError ? true : undefined} aria-describedby={`${id}-name-error`} />
          <FieldError id={`${id}-name-error`} message={nameError} />
        </label>
        <label className="span-2">
          <span>Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </label>
        <ErrorNote message={error} />
        <div className="actions span-2">
          <button className="btn btn-secondary" disabled={busy}>
            <BookmarkPlus size={15} aria-hidden /> {busy ? 'Saving…' : 'Save as template'}
          </button>
        </div>
      </form>
    </section>
  );
}
