import { FileUp } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, ImportReport, IssuedPass } from '../../shared/types';
import { attendeesFromCsv, parseCsv, type ParsedAttendees } from '../csv';
import { Modal } from '../dialog';
import { ErrorNote, FieldError, TableMessage, ToneBadge, errorMessage } from '../ui';
import { fromZoneInput, zoneLabel } from '../time';
import { adminApi } from './http';
import { PolicySelect } from './IssueForm';

const MAX_ROWS = 2000;
const MAX_FILE_BYTES = 2_000_000;
const SAMPLE_ROWS = 5;

const REASON_LABEL: Record<ImportReport['rejected'][number]['reason'], string> = {
  invalid_email: 'Invalid email',
  too_long: 'Too long',
  empty: 'Empty row',
  duplicate_in_file: 'Duplicate in file',
  already_has_pass: 'Already has a pass'
};

interface Props {
  event: EventSummary;
  policies: AdmissionPolicy[];
  onClose: () => void;
  /** Issued passes (tokens, once) and how many rows were skipped. */
  onImported: (passes: IssuedPass[], skipped: number) => Promise<void>;
}

/** CSV file or pasted text → server dry run (preview with rejected rows) → confirm → issue. */
export function ImportPasses({ event, policies, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [preview, setPreview] = useState<{ parsed: ParsedAttendees; report: ImportReport; policyId: string; expiresAt: string | null } | null>(null);
  const [inputError, setInputError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function readFile(file: File | undefined) {
    setInputError('');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setInputError('That file is larger than 2 MB. Split it into smaller files.');
      return;
    }
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch (err) {
      setInputError(`Could not read the file: ${errorMessage(err)}`);
    }
  }

  async function check(e: FormEvent) {
    e.preventDefault();
    setError('');
    const parsed = attendeesFromCsv(parseCsv(text));
    const expiresIso = expiresAt ? fromZoneInput(expiresAt, event.timeZone) : null;
    if (parsed.rows.length === 0) return setInputError('No attendee rows found. Choose a CSV file or paste rows with a name and/or email.');
    if (parsed.rows.length > MAX_ROWS) return setInputError(`Up to ${MAX_ROWS} rows per import; this list has ${parsed.rows.length}. Split it into smaller files.`);
    if (expiresAt && (!expiresIso || new Date(expiresIso).getTime() <= Date.now())) return setInputError('Choose an expiry in the future, or leave it empty.');
    setInputError('');
    setBusy(true);
    try {
      const report = await adminApi<ImportReport>(`/api/events/${event.id}/passes/import`, {
        body: { rows: parsed.rows, dryRun: true, ...(policyId ? { policyId } : {}), ...(expiresIso ? { expiresAt: expiresIso } : {}) }
      });
      setPreview({ parsed, report, policyId, expiresAt: expiresIso });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const report = await adminApi<ImportReport>(`/api/events/${event.id}/passes/import`, {
        body: {
          rows: preview.parsed.rows,
          dryRun: false,
          ...(preview.policyId ? { policyId: preview.policyId } : {}),
          ...(preview.expiresAt ? { expiresAt: preview.expiresAt } : {})
        }
      });
      await onImported(report.issued ?? [], report.rejected.length);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  let content;
  if (preview) {
    const { parsed, report } = preview;
    const policyName = policies.find((policy) => policy.id === preview.policyId)?.name;
    content = (
        <div className="stack">
          <div className="import-summary" role="status">
            <ToneBadge tone={report.accepted > 0 ? 'ok' : 'muted'}>{report.accepted} to issue</ToneBadge>
            <ToneBadge tone={report.rejected.length ? 'warn' : 'muted'}>{report.rejected.length} skipped</ToneBadge>
            <span className="muted small">{policyName ? `Policy: ${policyName}` : 'No policy'}</span>
          </div>
          <p className="muted small">
            {parsed.hasHeader
              ? `Header row found. Name: ${parsed.columns.name ?? 'none'}; email: ${parsed.columns.email ?? 'none'}.`
              : 'No header row: the first column is read as the name and the second as the email.'}{' '}
            Rows are numbered from the first attendee row.
          </p>

          <h3 className="label">First rows as read</h3>
          <div className="table-wrap import-table">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Row
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, SAMPLE_ROWS).map((row, index) => (
                  <tr key={index}>
                    <td className="num muted">{index + 1}</td>
                    <td>{row.name ?? <span className="muted">—</span>}</td>
                    <td>{row.email ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="label">Skipped rows</h3>
          <div className="table-wrap import-table">
            <table aria-label="Skipped rows">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Row
                  </th>
                  <th scope="col">Attendee</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {report.rejected.map((rejection) => {
                  const row = parsed.rows[rejection.row - 1];
                  return (
                    <tr key={rejection.row}>
                      <td className="num muted">{rejection.row}</td>
                      <td>
                        <div>{row?.name ?? <span className="muted">No name</span>}</div>
                        <div className="muted small">{row?.email ?? 'No email'}</div>
                      </td>
                      <td>
                        <div className="strong">{REASON_LABEL[rejection.reason]}</div>
                        {rejection.detail ? <div className="muted small">{rejection.detail}</div> : null}
                      </td>
                    </tr>
                  );
                })}
                {report.rejected.length === 0 ? <TableMessage colSpan={3}>Every row can be issued.</TableMessage> : null}
              </tbody>
            </table>
          </div>
          <ErrorNote message={error} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setPreview(null)} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void confirmImport()} disabled={busy || report.accepted === 0}>
              {busy ? 'Issuing…' : report.accepted === 0 ? 'Nothing to issue' : `Issue ${report.accepted} pass${report.accepted === 1 ? '' : 'es'}`}
            </button>
          </div>
        </div>
    );
  } else {
    content = (
      <form className="stack" onSubmit={check} noValidate>
        <p className="muted small">
          Columns are found from a header row such as <code>Name,Email</code> (or <code>First name,Last name,Email</code>). Without one, the first column is the name and the second the email.
          Duplicate emails and attendees who already have a pass are skipped. Up to {MAX_ROWS} rows.
        </p>
        <label>
          CSV file
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} />
          {fileName ? <span className="field-hint">Loaded {fileName}. You can edit the rows below.</span> : null}
        </label>
        <label>
          Or paste rows
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Name,Email\n"Lovelace, Ada",ada@example.com\nGrace Hopper,grace@example.com'}
            aria-invalid={inputError ? true : undefined}
            aria-describedby={`${id}-error`}
          />
          <FieldError id={`${id}-error`} message={inputError} />
        </label>
        <PolicySelect id={`${id}-policy`} policies={policies} value={policyId} onChange={setPolicyId} />
        <label>
          Expires
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-describedby={`${id}-expiry`} />
          <span id={`${id}-expiry`} className="field-hint">
            In {zoneLabel(event.timeZone, event.endsAt)}. Empty: when the event ends.
          </span>
        </label>
        <ErrorNote message={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !text.trim()}>
            <FileUp size={15} aria-hidden /> {busy ? 'Checking…' : 'Preview import'}
          </button>
        </div>
      </form>
    );
  }

  // One dialog for both steps, so focus and the backdrop stay put when moving between them.
  return (
    <Modal title={preview ? 'Check the import' : 'Import attendees from CSV'} onClose={onClose}>
      {content}
    </Modal>
  );
}
