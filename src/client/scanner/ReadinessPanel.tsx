import { CircleCheck, CircleDashed, CircleX, Info, RotateCcw, ScanLine, TriangleAlert, type LucideIcon } from 'lucide-react';
import { isReady, type ItemState, type ReadinessItem } from './readiness';

/** Words beside each icon, so no state rests on colour or shape alone. */
const STATE_WORD: Record<ItemState, string> = { ok: 'Passed', warn: 'Check', fail: 'Problem', pending: 'To do', info: 'Confirm' };
const STATE_ICON: Record<ItemState, LucideIcon> = { ok: CircleCheck, warn: TriangleAlert, fail: CircleX, pending: CircleDashed, info: Info };

interface Props {
  items: ReadinessItem[];
  /** The browser reports a network connection. */
  online: boolean;
  /** The last server round trip succeeded. */
  serverOk: boolean;
  /** A service worker controls the page: the app shell opens without a connection. */
  offlineShell: boolean;
  checking: boolean;
  /** The camera test is running (camera started in test mode). */
  testing: boolean;
  /** Feedback from the camera test, e.g. a pass held up instead of the test code. */
  hint: string;
  onCheckAgain: () => void;
  onTestCamera: () => void;
  onStart: () => void;
}

/**
 * Pre-shift checklist (readiness.ts decides the items). Advisory: staff may start
 * anyway, but the server still judges every pass and scanning stays paused offline.
 */
export function ReadinessPanel({ items, online, serverOk, offlineShell, checking, testing, hint, onCheckAgain, onTestCamera, onStart }: Props) {
  const ready = isReady(items);
  const verification = online && serverOk;
  return (
    <section className="readiness" aria-labelledby="readiness-title">
      <h2 id="readiness-title" className="readiness-title">
        Before you scan
      </h2>
      {/* What runs on this phone versus what only the server can do: an offline copy of the app never admits anyone. */}
      <dl className="readiness-shell">
        <div>
          <dt>App</dt>
          <dd>{online ? (offlineShell ? 'Loaded · opens offline' : 'Loaded') : 'Loaded (offline copy)'}</dd>
        </div>
        <div className={verification ? 'is-ok' : 'is-fail'}>
          <dt>Server verification</dt>
          <dd>{verification ? 'Available' : 'Unavailable — do not admit anyone'}</dd>
        </div>
      </dl>
      <ul className="readiness-list">
        {items.map((item) => {
          const Icon = STATE_ICON[item.state];
          return (
            <li key={item.id} className={`readiness-item is-${item.state}`} data-check={item.id}>
              <Icon size={20} className="readiness-icon" aria-hidden />
              <div className="readiness-text">
                <div className="readiness-label">
                  <span>{item.label}</span>
                  <span className="readiness-state">{STATE_WORD[item.state]}</span>
                </div>
                <div className="readiness-detail">{item.detail}</div>
                {item.guidance ? <p className="readiness-guidance">{item.guidance}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {hint ? (
        <p className="readiness-hint" role="status">
          {hint}
        </p>
      ) : null}
      <div className="readiness-actions">
        <button type="button" className="btn btn-secondary" onClick={onTestCamera} disabled={testing}>
          <ScanLine size={16} aria-hidden /> {testing ? 'Camera test running' : 'Test camera'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCheckAgain} disabled={checking}>
          <RotateCcw size={16} aria-hidden /> {checking ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onStart}>
          {ready ? 'Start scanning' : 'Start scanning anyway'}
        </button>
      </div>
    </section>
  );
}
