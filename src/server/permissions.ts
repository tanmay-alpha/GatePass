import type { AccountUser, EventPermission, EventRole } from '../shared/types';

/**
 * Who is calling. `operator` is the break-glass ADMIN_TOKEN: API-only, never
 * offered in the UI, every action audited as `operator`. Everyone else is an
 * account with a cookie session (docs/decisions/0008-accounts-and-event-roles.md).
 */
export type Principal = { kind: 'operator' } | { kind: 'user'; user: AccountUser };

/**
 * Event roles. Owners hold everything; managers run day-to-day operations but
 * cannot change the event lifecycle, its team, or export attendee data.
 * Scanning staff are scanner devices (`/api/scanner/*`), not accounts.
 */
export const ROLE_PERMISSIONS: Record<EventRole, readonly EventPermission[]> = {
  owner: ['view', 'edit', 'lifecycle', 'team', 'access', 'passes', 'scanners', 'audit', 'export'],
  manager: ['view', 'edit', 'access', 'passes', 'scanners', 'audit']
};

export function roleAllows(role: EventRole, permission: EventPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Audit-log actor string: `operator` or `user:<id>`. */
export function actorOf(principal: Principal): string {
  return principal.kind === 'operator' ? 'operator' : `user:${principal.user.id}`;
}
