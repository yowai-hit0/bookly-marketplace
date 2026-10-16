import * as React from "react"

/**
 * Which look a `StatusBadge` takes when its caller does not say. The admin
 * layout provides `console`, so every badge under it -- the stage legend's
 * popover too, since context passes through a portal -- takes the console look
 * (design-system/bookly/admin-console.md section 5), while client pages keep
 * the default.
 */
export const StatusBadgeVariantContext = React.createContext<"default" | "console">("default")
