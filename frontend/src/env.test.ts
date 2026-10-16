import { describe, expect, it } from 'vitest'
import { EnvValidationError, parseEnv } from './env'

describe('parseEnv', () => {
  it('defaults the API base to the same-origin /api path', () => {
    expect(parseEnv({}).VITE_API_BASE_URL).toBe('/api')
  })

  it('accepts an absolute URL for a cross-origin deployment', () => {
    expect(parseEnv({ VITE_API_BASE_URL: 'https://api.example.com' }).VITE_API_BASE_URL).toBe(
      'https://api.example.com',
    )
  })

  it('throws a named error when the API base is neither a path nor a URL', () => {
    expect(() => parseEnv({ VITE_API_BASE_URL: 'api.example.com' })).toThrow(EnvValidationError)
  })
})
