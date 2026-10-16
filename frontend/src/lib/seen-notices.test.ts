import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_SHOWN_FOR_MS, dismissNotice, isNoticeShown, markNoticesSeen, readSeen } from './seen-notices'

/**
 * A booking's notices, remembered on this device (docs/prompts/client-access-and-admin-polish.md, item 8).
 *
 * What is proven: a notice shows until closed or until a day after it was
 * first seen; `balance_due` is never hidden by time, only by closing it; a
 * first-seen stamp is never moved later; each booking keeps its own memory;
 * and storage that throws or holds rubbish means "nothing remembered".
 */

const NOW = Date.parse('2026-10-07T08:00:00Z')
const REF = 'BKY-2610-7K3QX'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('which notices show', () => {
  it('shows a notice never seen here', () => {
    expect(isNoticeShown({ id: 'outbox:1', kind: 'reschedule' }, {}, NOW)).toBe(true)
  })

  it('shows it for a day after it was first seen, then hides it', () => {
    markNoticesSeen(REF, ['outbox:1'], NOW)
    const seen = readSeen(REF)

    expect(isNoticeShown({ id: 'outbox:1', kind: 'reschedule' }, seen, NOW + NOTICE_SHOWN_FOR_MS - 1)).toBe(true)
    expect(isNoticeShown({ id: 'outbox:1', kind: 'reschedule' }, seen, NOW + NOTICE_SHOWN_FOR_MS)).toBe(false)
  })

  it('never hides money still owed by time, only by closing it', () => {
    markNoticesSeen(REF, ['balance:33000'], NOW)
    expect(isNoticeShown({ id: 'balance:33000', kind: 'balance_due' }, readSeen(REF), NOW + 30 * NOTICE_SHOWN_FOR_MS)).toBe(true)

    dismissNotice(REF, 'balance:33000', NOW)
    expect(isNoticeShown({ id: 'balance:33000', kind: 'balance_due' }, readSeen(REF), NOW)).toBe(false)
    // A new amount is a new notice.
    expect(isNoticeShown({ id: 'balance:13000', kind: 'balance_due' }, readSeen(REF), NOW)).toBe(true)
  })

  it('hides a closed notice at once', () => {
    dismissNotice(REF, 'note:1', NOW)
    expect(isNoticeShown({ id: 'note:1', kind: 'note' }, readSeen(REF), NOW)).toBe(false)
  })

  it('never moves a first-seen stamp later', () => {
    markNoticesSeen(REF, ['outbox:1'], NOW)
    markNoticesSeen(REF, ['outbox:1'], NOW + 5_000)

    expect(readSeen(REF)['outbox:1']?.firstSeenAt).toBe(NOW)
  })

  it('keeps each booking to itself', () => {
    dismissNotice(REF, 'outbox:1', NOW)
    expect(readSeen('BKY-2610-OTHER')).toEqual({})
  })

  it('reads storage that throws, or holds rubbish, as nothing remembered', () => {
    localStorage.setItem(`bookly.notices.${REF}`, 'not json')
    expect(readSeen(REF)).toEqual({})

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readSeen(REF)).toEqual({})
    expect(() => markNoticesSeen(REF, ['outbox:1'], NOW)).not.toThrow()
    expect(() => dismissNotice(REF, 'outbox:1', NOW)).not.toThrow()
  })
})
