import * as React from "react"

/**
 * The first focusable element in a shell: hidden until focused, then a pill at
 * the top left, above everything (design-system MASTER.md; `pages/client-
 * shell.md` and `pages/admin-shell.md` both specify it).
 *
 * A plain anchor, never a router `Link`: the browser's own fragment navigation
 * is what moves focus to the target's `tabIndex={-1}`, and a client-side
 * navigation would skip nothing.
 *
 * Both shells wrote this identical class list before it was a component.
 */
function SkipLink({ targetId, children }: { targetId: string; children: React.ReactNode }) {
  return (
    <a
      href={`#${targetId}`}
      data-slot="skip-link"
      className="bg-primary text-primary-foreground focus-visible:ring-ring/50 sr-only rounded-lg px-4 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus-visible:ring-3 client:rounded-xs client:border client:bg-background client:text-foreground"
    >
      {children}
    </a>
  )
}

export { SkipLink }
