import { Calendar, MapPin, Users } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EventSummary } from '../../shared/types';
import { Stat, ToneBadge } from '../ui';
import { formatRangeInZone } from '../time';
import { AccessPanel } from './AccessPanel';
import { AuditPanel } from './AuditPanel';
import { DesignPanel } from './DesignPanel';
import { ROLE_LABEL, STATUS_META, can } from './model';
import { OperationsPanel } from './OperationsPanel';
import { PassesPanel } from './PassesPanel';
import { SettingsPanel } from './SettingsPanel';
import { SetupChecklist, needsSetup, type SetupTarget } from './SetupChecklist';
import { TeamPanel } from './TeamPanel';

export const EVENT_TABS = [
  { id: 'operations', label: 'Operations' },
  { id: 'passes', label: 'Passes' },
  { id: 'access', label: 'Access' },
  { id: 'team', label: 'Team' },
  { id: 'design', label: 'Pass design' },
  { id: 'settings', label: 'Settings' },
  { id: 'audit', label: 'Audit log' }
] as const;

export type EventTab = (typeof EVENT_TABS)[number]['id'];

interface Props {
  event: EventSummary;
  tab: EventTab;
  onTab: (tab: EventTab) => void;
  onChanged: () => Promise<void>;
  /** Reloads the event list and opens another event (after cloning). */
  onOpenEvent: (eventId: string) => Promise<void>;
}

export function EventDetail({ event, tab: requestedTab, onTab, onChanged, onOpenEvent }: Props) {
  const tabs = EVENT_TABS.filter((item) => item.id !== 'audit' || can(event, 'audit'));
  const tab = tabs.some((item) => item.id === requestedTab) ? requestedTab : 'operations';
  const tabList = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<EventTab, HTMLButtonElement | null>>>({});
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const unused = Math.max(event.passCount - event.redeemedCount - event.revokedCount, 0);
  const status = STATUS_META[event.status];

  /** On narrow screens the tab bar scrolls sideways; keep the active tab visible. */
  useEffect(() => {
    const list = tabList.current;
    const active = tabRefs.current[tab];
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const listBox = list.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.left >= listBox.left && box.right <= listBox.right) return;
    list.scrollLeft += box.left - listBox.left - (listBox.width - box.width) / 2;
  }, [tab]);

  /** After a checklist action switches tab, scroll to and focus the relevant control once it has rendered. */
  useEffect(() => {
    if (!focusTarget) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const element = document.querySelector<HTMLElement>(focusTarget);
      if (element) {
        element.scrollIntoView({ block: 'center' });
        element.focus({ preventScroll: true });
        setFocusTarget(null);
      } else if (++tries < 60) frame = requestAnimationFrame(attempt);
      else setFocusTarget(null);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusTarget, tab]);

  function go(target: SetupTarget) {
    onTab(target.tab);
    setFocusTarget(target.focus);
  }

  /** Roving focus: arrows, Home and End move between tabs and activate them. */
  function onTabKey(e: KeyboardEvent) {
    const index = tabs.findIndex((item) => item.id === tab);
    const moves: Partial<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length].id;
    onTab(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <div className="stack-lg">
      <section className="event-summary" aria-labelledby="event-title">
        <div className="event-head">
          <h1 id="event-title">{event.name}</h1>
          <div className="event-badges">
            <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
            <span className="muted small">
              Your role: <span className="strong">{ROLE_LABEL[event.myRole]}</span>
            </span>
          </div>
          <p className="event-meta">
            <span title={event.timeZone}>
              <Calendar size={15} aria-hidden /> <span className="num">{formatRangeInZone(event.startsAt, event.endsAt, event.timeZone)}</span>
            </span>
            {event.venue ? (
              <span>
                <MapPin size={15} aria-hidden /> {event.venue}
              </span>
            ) : null}
            {event.capacity !== null ? (
              <span>
                <Users size={15} aria-hidden /> <span className="num">Capacity {event.capacity}</span>
              </span>
            ) : null}
          </p>
          {event.status === 'active' ? null : <p className="muted small event-status-note">{status.summary}</p>}
        </div>
        <div className="stats">
          <Stat label="Passes issued" value={event.passCount} />
          <Stat label="Named attendees" value={event.attendeeCount} />
          <Stat label="Checked in" value={event.redeemedCount} />
          <Stat label="Not yet used" value={unused} />
          <Stat label="Revoked" value={event.revokedCount} />
        </div>
      </section>

      {needsSetup(event) ? <SetupChecklist event={event} onGo={go} /> : null}

      <div ref={tabList} className="tabs" role="tablist" aria-label="Event sections" onKeyDown={onTabKey}>
        {tabs.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[item.id] = element;
            }}
            id={`tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className={`tab${tab === item.id ? ' active' : ''}`}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={-1}>
        {tab === 'operations' && <OperationsPanel event={event} onChanged={onChanged} />}
        {tab === 'passes' && <PassesPanel event={event} onChanged={onChanged} />}
        {tab === 'access' && <AccessPanel event={event} onChanged={onChanged} />}
        {tab === 'team' && <TeamPanel event={event} onChanged={onChanged} />}
        {tab === 'design' && <DesignPanel event={event} onChanged={onChanged} />}
        {tab === 'settings' && <SettingsPanel event={event} onChanged={onChanged} onOpenEvent={onOpenEvent} />}
        {tab === 'audit' && <AuditPanel event={event} />}
      </section>
    </div>
  );
}
