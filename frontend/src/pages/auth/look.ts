import type { Area } from '@/auth/session'

/** The studio and the platform are consoles; the account belongs to the client site (`kit.tsx`). */
export type Look = 'console' | 'client'

export function lookOf(area: Area): Look {
  return area === 'account' ? 'client' : 'console'
}
