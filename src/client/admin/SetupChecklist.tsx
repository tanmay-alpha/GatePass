import { Check, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import type { EventSummary } from '../../shared/types';
import { Bar, SectionHead, ToneBadge } from '../ui';
import type { EventTab } from './EventDetail';

/** Where a step's action leads: a tab and the control to focus on it. */
export interface SetupTarget {
  tab: EventTab;
  /** CSS selector of the control to scroll to and focus once the tab has rendered. */
  focus: string;
}

export const SETUP_TARGETS = {
  gates: { tab: 'access', focus: '#gate-name-input' },
  policies: { tab: 'access', focus: '#new-policy-button' },
  passes: { tab: 'passes', focus: '#issue-passes :is(textarea, input)' },
  scanner: { tab: 'access', focus: '#device-label-input' },
  open: { tab: 'settings', focus: '#status-to-active' },
  operations: { tab: 'operations', focus: '[role="tabpanel"]' }
} satisfies Record<string, SetupTarget>;

type Skippable = 'gates' | 'policies';

interface Prefs {
  collapsed: boolean;
  skipped: Skippable[];
}

const prefsKey = (eventId: string) => `gatepass.setup.${eventId}`;

function loadPrefs(eventId: string): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(prefsKey(eventId)) ?? 'null') as Partial<Prefs> | null;
    return { collapsed: stored?.collapsed === true, skipped: Array.isArray(stored?.skipped) ? stored.skipped.filter((id) => id === 'gates' || id === 'policies') : [] };
  } catch {
    return { collapsed: false, skipped: [] };
  }
}

/** Collapse state and skipped steps, remembered per event on this browser. */
function useSetupPrefs(eventId: string): [Prefs, (change: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(() => loadPrefs(eventId));
  function update(change: Partial<Prefs>) {
    const next = { ...prefs, ...change };
    setPrefs(next);
    try {
      localStorage.setItem(prefsKey(eventId), JSON.stringify(next));
    } catch {
      // Storage can be full or blocked; the choice still holds for this page view.
    }
  }
  return [prefs, update];
}

interface Step {
  id: 'create' | Skippable | 'passes' | 'scanner' | 'open' | 'entry';
  title: string;
  description: string;
  done: boolean;
  optional: boolean;
  skipped: boolean;
  /** Names the step in the Skip button's accessible name, e.g. "Skip gates". */
  skipName?: string;
  action?: { label: string; target: SetupTarget };
}

function buildSteps(event: EventSummary, skipped: Skippable[]): Step[] {
  const gatesSkipped = skipped.includes('gates') && event.gateCount === 0;
  const policiesSkipped = skipped.includes('policies') && event.policyCount === 0;
  return [
    { id: 'create', title: 'Create event', description: 'Name, venue and the time the doors are open.', done: true, optional: false, skipped: false },
    {
      id: 'gates',
      title: 'Add gates',
      description: 'One per entrance. Skip if you have a single door.',
      done: event.gateCount > 0 || gatesSkipped,
      optional: true,
      skipped: gatesSkipped,
      skipName: 'gates',
      action: { label: 'Set up gates', target: SETUP_TARGETS.gates }
    },
    {
      id: 'policies',
      title: 'Configure admission',
      description: 'Limit some passes to a time slot, gate or capacity. Skip for general admission.',
      done: event.policyCount > 0 || policiesSkipped,
      optional: true,
      skipped: policiesSkipped,
      skipName: 'admission rules',
      action: { label: 'Set up admission', target: SETUP_TARGETS.policies }
    },
    {
      id: 'passes',
      title: 'Issue passes',
      description: 'Add attendees and share each pass link.',
      done: event.passCount > 0,
      optional: false,
      skipped: false,
      action: { label: 'Issue passes', target: SETUP_TARGETS.passes }
    },
    {
      id: 'scanner',
      title: 'Set up a scanner',
      description: 'Open the setup link on each door phone.',
      done: event.scannerCount > 0,
      optional: false,
      skipped: false,
      action: { label: 'Set up a scanner', target: SETUP_TARGETS.scanner }
    },
    {
      id: 'open',
      title: 'Open the event (set Active)',
      description: event.permissions.includes('lifecycle')
        ? 'Scanners refuse every pass while the event is a draft. Open it when the doors are ready.'
        : 'Scanners refuse every pass while the event is a draft. Ask the event owner to open it.',
      done: event.status === 'active',
      optional: false,
      skipped: false,
      action: event.permissions.includes('lifecycle') ? { label: 'Open the event', target: SETUP_TARGETS.open } : undefined
    },
    {
      id: 'entry',
      title: 'Begin entry',
      description: 'Scan the first pass at the door. Watch progress on Operations.',
      done: event.scanCount > 0,
      optional: false,
      skipped: false,
      action: { label: 'Open Operations', target: SETUP_TARGETS.operations }
    }
  ];
}

/** Active, with passes and at least one scanner: the event can admit people. */
export function isReadyForDoors(event: EventSummary): boolean {
  return event.status === 'active' && event.passCount > 0 && event.scannerCount > 0;
}

/** Shown for draft and active events that have not ended, until entry has begun. */
export function needsSetup(event: EventSummary): boolean {
  if ((event.status !== 'draft' && event.status !== 'active') || new Date(event.endsAt).getTime() <= Date.now()) return false;
  return !(isReadyForDoors(event) && event.scanCount > 0);
}

/**
 * "Set up this event": the order of operations for a first-time organiser, with
 * each step's done state taken from the event's counts. Optional steps can be skipped.
 */
export function SetupChecklist({ event, onGo }: { event: EventSummary; onGo: (target: SetupTarget) => void }) {
  const [prefs, updatePrefs] = useSetupPrefs(event.id);
  const steps = buildSteps(event, prefs.skipped);
  const doneCount = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done);
  const next = current?.action;

  if (isReadyForDoors(event)) {
    return (
      <section className="card setup setup-ready" aria-labelledby="setup-title">
        <CircleCheck className="setup-ready-icon" size={22} aria-hidden />
        <div className="setup-ready-text">
          <h2 id="setup-title">Ready for doors</h2>
          <p className="muted small">Passes are issued and a scanner is set up. Scan the first pass at the door and watch progress on Operations.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary btn-small" onClick={() => onGo(SETUP_TARGETS.operations)}>
            Open Operations
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onGo(SETUP_TARGETS.scanner)}>
            Scanner setup
          </button>
        </div>
      </section>
    );
  }

  const progress = `${doneCount} of ${steps.length} steps done`;

  if (prefs.collapsed) {
    return (
      <section className="card setup setup-collapsed" aria-labelledby="setup-title">
        <div className="setup-summary">
          <h2 id="setup-title">Set up this event</h2>
          <span className="setup-meter">
            <Bar value={doneCount} max={steps.length} />
          </span>
          <span className="muted small num">{progress}</span>
        </div>
        <div className="actions">
          {next ? (
            <button type="button" className="btn btn-primary btn-small" onClick={() => onGo(next.target)} aria-label={`Continue: ${next.label}`}>
              Continue
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-small" aria-expanded={false} onClick={() => updatePrefs({ collapsed: false })}>
            Show steps
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card setup" aria-labelledby="setup-title">
      <SectionHead id="setup-title" title="Set up this event" description={`${progress}. Work from the top; optional steps can be skipped.`}>
        <span className="setup-meter">
          <Bar value={doneCount} max={steps.length} />
        </span>
        <button type="button" className="btn btn-ghost btn-small" aria-expanded={true} onClick={() => updatePrefs({ collapsed: true })}>
          Hide steps
        </button>
      </SectionHead>
      <ol className="setup-steps">
        {steps.map((step, index) => {
          const isCurrent = step === current;
          const action = step.done ? undefined : step.action;
          const state = step.skipped ? 'skipped' : step.done ? 'done' : isCurrent ? 'current' : 'todo';
          return (
            <li key={step.id} className={`setup-step setup-step-${state}`} aria-current={isCurrent ? 'step' : undefined}>
              <span className="setup-marker num" aria-hidden>
                {step.done && !step.skipped ? <Check size={14} strokeWidth={3} /> : index + 1}
              </span>
              <div className="setup-step-body">
                <h3 className="setup-step-title">
                  {step.title}
                  {step.skipped ? <ToneBadge tone="muted">Skipped</ToneBadge> : step.done ? <ToneBadge tone="ok">Done</ToneBadge> : isCurrent ? <ToneBadge tone="info">Next</ToneBadge> : null}
                  {step.optional && !step.done ? <span className="muted small setup-optional">Optional</span> : null}
                </h3>
                <p className="muted small">{step.description}</p>
              </div>
              <div className="setup-step-actions">
                {action ? (
                  <button type="button" className={`btn btn-small ${isCurrent ? 'btn-primary' : 'btn-secondary'}`} onClick={() => onGo(action.target)}>
                    {action.label}
                  </button>
                ) : null}
                {step.optional && !step.done ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    aria-label={`Skip ${step.skipName}`}
                    onClick={() => updatePrefs({ skipped: [...prefs.skipped, step.id as Skippable] })}
                  >
                    Skip
                  </button>
                ) : null}
                {step.skipped ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    aria-label={`Undo skip: ${step.skipName}`}
                    onClick={() => updatePrefs({ skipped: prefs.skipped.filter((id) => id !== step.id) })}
                  >
                    Undo skip
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
