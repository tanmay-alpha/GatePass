import type { EventPermission, EventRole, EventStatus, EventSummary, InvitationRole, PlatformRole } from '../../shared/types';
import type { Tone } from '../ui';

/** The server enforces the same list; the UI hides or disables what the caller may not do. */
export function can(event: EventSummary, permission: EventPermission): boolean {
  return event.permissions.includes(permission);
}

export const ROLE_LABEL: Record<EventRole | 'operator', string> = {
  owner: 'Owner',
  manager: 'Manager',
  operator: 'Operator'
};

export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  organizer: 'Organizer',
  platform_admin: 'Platform admin'
};

export const INVITATION_ROLE_LABEL: Record<InvitationRole, string> = {
  organizer: 'Organizer',
  platform_admin: 'Platform admin',
  manager: 'Event manager'
};

export const STATUS_META: Record<EventStatus, { label: string; tone: Tone; summary: string }> = {
  draft: { label: 'Draft', tone: 'info', summary: 'Being set up. Scanners refuse every pass until the event is opened.' },
  active: { label: 'Active', tone: 'ok', summary: 'Doors open. Scanners admit valid passes inside the event and policy windows.' },
  ended: { label: 'Ended', tone: 'warn', summary: 'Closed. Scanners refuse every pass; the event can be reopened.' },
  archived: { label: 'Archived', tone: 'muted', summary: 'Read-only history. Nothing can be changed and no one is admitted.' }
};

/** Allowed lifecycle moves, mirroring the server: only `active` admits. */
export const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ['active', 'archived'],
  active: ['ended', 'archived'],
  ended: ['active', 'archived'],
  archived: ['ended']
};

/** Passes can be issued or imported only while the event is a draft or active. */
export function issuesPasses(event: EventSummary): boolean {
  return event.status === 'draft' || event.status === 'active';
}

/** Shown where issuing is unavailable for an ended or archived event. */
export const ISSUE_BLOCKED: Record<EventStatus, string> = {
  draft: '',
  active: '',
  ended: 'This event has ended, so no new passes can be issued. The owner can reopen it in Settings.',
  archived: 'This event is archived and read-only, so no new passes can be issued. The owner can move it back to Ended in Settings.'
};

/** Archived events are read-only: gates, policies, devices, passes and details cannot change. */
export const ARCHIVED_NOTE = 'This event is archived and read-only. The owner can move it back to Ended in Settings to make changes.';
