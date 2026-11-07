import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate } from '../../shared/types';
import { api } from '../api';
import { ErrorNote, SectionHead, errorMessage } from '../ui';
import { useResource } from './hooks';
import { PoliciesSection } from './PoliciesSection';
import { ScannersSection } from './ScannersSection';
import { useToast } from './toast';

/** Where and when passes are accepted: gates, admission policies and the door devices bound to gates. */
export function AccessPanel({ token, event }: { token: string; event: EventSummary }) {
  const gates = useResource<Gate[]>(`/api/events/${event.id}/gates`, token);
  const policies = useResource<AdmissionPolicy[]>(`/api/events/${event.id}/policies`, token);

  return (
    <div className="stack-lg">
      <GatesSection token={token} event={event} gates={gates.data} error={gates.error} onCreated={gates.reload} />
      <PoliciesSection token={token} event={event} gates={gates.data ?? []} policies={policies.data} error={policies.error} onChanged={policies.reload} />
      <ScannersSection token={token} event={event} gates={gates.data ?? []} />
    </div>
  );
}

interface GatesProps {
  token: string;
  event: EventSummary;
  gates: Gate[] | null;
  error: string;
  onCreated: () => Promise<void>;
}

function GatesSection({ token, event, gates, error: loadError, onCreated }: GatesProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const notify = useToast();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const gate = await api<Gate>(`/api/events/${event.id}/gates`, token, { body: { name: name.trim() } });
      setName('');
      await onCreated();
      notify(`Gate “${gate.name}” added`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="gates-title">
      <SectionHead id="gates-title" title="Gates" description="Physical entrances. Bind scanner devices to a gate and limit policies to specific gates." />
      <div className="gate-row">
        {gates?.length ? (
          <ul className="chips" aria-label="Gates">
            {gates.map((gate) => (
              <li key={gate.id} className="chip">
                <span>{gate.name}</span>
                <span className="chip-count num" title={`${gate.admittedCount} admitted`}>
                  {gate.admittedCount}
                  <span className="sr-only"> admitted</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="inline-form gate-form" onSubmit={create}>
          <label className="grow">
            <span className="sr-only">Gate name</span>
            <input placeholder="Gate name, e.g. North entrance" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required disabled={event.status !== 'active'} />
          </label>
          <button className="btn btn-secondary" disabled={busy || event.status !== 'active' || !name.trim()}>
            <Plus size={16} aria-hidden /> {busy ? 'Adding…' : 'Add gate'}
          </button>
        </form>
      </div>
      {gates === null && !loadError ? <p className="muted small" role="status">Loading gates…</p> : null}
      {gates?.length === 0 ? <p className="muted small">No gates yet. Without gates every device scans for the whole venue; add one per entrance to track and restrict entry by gate.</p> : null}
      <ErrorNote message={error || loadError} />
    </section>
  );
}
