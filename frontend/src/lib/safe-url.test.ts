import { describe, expect, it } from 'vitest'
import { safeHttpsUrl } from './safe-url'

describe('safeHttpsUrl', () => {
  it('keeps an https URL as given', () => {
    expect(safeHttpsUrl('https://photos.example.com/album/1')).toBe('https://photos.example.com/album/1')
  })

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://photos.example.com',
    '//photos.example.com',
    '/relative/path',
    'not a url',
    '',
  ])('refuses %j', (value) => {
    expect(safeHttpsUrl(value)).toBeNull()
  })

  it('refuses null and undefined', () => {
    expect(safeHttpsUrl(null)).toBeNull()
    expect(safeHttpsUrl(undefined)).toBeNull()
  })
})
