import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

/**
 * jsdom ships no `ResizeObserver`, which Radix measures its hidden form inputs
 * with (a controlled `Checkbox` reaches for it once its control has mounted).
 * Every browser the app supports has it, so this is an environment gap rather
 * than anything the app should work around.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
