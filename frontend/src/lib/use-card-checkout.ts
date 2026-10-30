import { useCallback, useEffect, useRef, useState } from 'react'
import { type CardCheckoutHandle, type InlineCardConfig, openCardCheckout } from './flutterwave-inline'

/**
 * The card half of a pay page (marketplace-spec.md "Cards as built"): after
 * the API answers a card payment, open Flutterwave's modal with its config and
 * say what happened, in one place for the checkout, the guest and account
 * booking pages and the studio subscription.
 *
 *   idle         nothing open
 *   opening      the script is loading, or the modal is being opened
 *   open         the modal is up
 *   closed       the payer closed it with no callback: the page stays, the
 *                button is usable again, and it says nothing was charged
 *   loadFailed   the script could not be loaded: an inline error
 *
 * A callback hands its transaction id to `onCompleted`, which moves to the
 * payment's progress page; the modal is closed first. Nothing here says a
 * payment succeeded. Leaving the page closes the modal.
 */

export type CardPhase = 'idle' | 'opening' | 'open' | 'closed' | 'loadFailed'

export function useCardCheckout() {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const handle = useRef<CardCheckoutHandle | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      handle.current?.close()
      handle.current = null
    }
  }, [])

  const open = useCallback(async (config: InlineCardConfig, onCompleted: (transactionId: string | null) => void) => {
    handle.current?.close()
    handle.current = null
    setPhase('opening')
    let opened: CardCheckoutHandle
    try {
      opened = await openCardCheckout(config, {
        onCallback: (transactionId) => {
          handle.current = null
          if (!mounted.current) return
          setPhase('idle')
          onCompleted(transactionId)
        },
        onClose: () => {
          handle.current = null
          if (mounted.current) setPhase('closed')
        },
      })
    } catch {
      if (mounted.current) setPhase('loadFailed')
      return
    }
    if (!mounted.current) {
      opened.close()
      return
    }
    handle.current = opened
    // A callback or close may already have run while the modal was being opened.
    setPhase((current) => (current === 'opening' ? 'open' : current))
  }, [])

  const reset = useCallback(() => setPhase('idle'), [])

  return { phase, busy: phase === 'opening' || phase === 'open', open, reset }
}
