import { createContext, useContext } from 'react';
import type { AccountUser } from '../../shared/types';

/** The signed-in account, provided by the admin shell. */
export const CurrentUserContext = createContext<AccountUser | null>(null);

export function useCurrentUser(): AccountUser | null {
  return useContext(CurrentUserContext);
}
