import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate } from '../../shared/types';
import { api, formatDateTime } from '../api';
import { ErrorNote, SectionHead, TableMessage, errorMessage } from '../ui';
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
      <form className="inline-form" onSubmit={create}>
        <label className="grow">
          <span className="sr-only">Gate name</span>
          <input placeholder="Gate name, e.g. North entrance" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required disabled={event.status !== 'active'} />
        </label>
        <button className="btn btn-primary" disabled={busy || event.status !== 'active' || !name.trim()}>
          <Plus size={16} aria-hidden /> {busy ? 'Adding…' : 'Add gate'}
        </button>
      </form>
      <ErrorNote message={error || loadError} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Gate</th>
              <th scope="col" className="num">
                Admitted
              </th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {gates?.map((gate) => (
              <tr key={gate.id}>
                <td>{gate.name}</td>
                <td className="num">{gate.admittedCount}</td>
                <td className="small">{formatDateTime(gate.createdAt)}</td>
              </tr>
            ))}
            {gates === null && !loadError ? <TableMessage colSpan={3}>Loading gates…</TableMessage> : null}
            {gates?.length === 0 ? <TableMessage colSpan={3}>No gates yet. Without gates every device scans for the whole venue; add one per entrance to track and restrict entry by gate.</TableMessage> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
