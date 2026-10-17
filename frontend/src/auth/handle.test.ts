import { describe, expect, it } from 'vitest'
import { HANDLE_PATTERN, handleRules, isValidHandle, normaliseHandle } from './handle'

/** The handle rule mirrors the API's, `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$` after trimming and lowercasing. */

describe('the handle rule', () => {
  it('is the backend’s pattern', () => {
    expect(HANDLE_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$')
  })

  it.each(['abc', 'kigali-lens', 'a1b', 'studio-2026', 'a'.repeat(30), '  Kigali-Lens  '])('accepts %j', (raw) => {
    expect(isValidHandle(raw)).toBe(true)
    expect(handleRules(raw)).toEqual({ length: true, chars: true, edges: true })
  })

  it.each<[string, { length: boolean; chars: boolean; edges: boolean }]>([
    ['', { length: false, chars: false, edges: false }],
    ['ab', { length: false, chars: true, edges: true }],
    ['a'.repeat(31), { length: false, chars: true, edges: true }],
    ['-abc', { length: true, chars: true, edges: false }],
    ['abc-', { length: true, chars: true, edges: false }],
    ['kigali_lens', { length: true, chars: false, edges: true }],
    ['kigali lens', { length: true, chars: false, edges: true }],
    ['café', { length: true, chars: false, edges: false }],
  ])('refuses %j, naming which part fails', (raw, rules) => {
    expect(isValidHandle(raw)).toBe(false)
    expect(handleRules(raw)).toEqual(rules)
  })

  it('normalises as the API does', () => {
    expect(normaliseHandle('  Kigali-Lens ')).toBe('kigali-lens')
  })
})
