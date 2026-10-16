import { type ReactNode, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { InDialogContext } from './in-dialog'

/**
 * A create or edit form in a modal (admin console fixes, item 1, 2026-09-27).
 * The page keeps its own open state: `open` shows it, and Escape, the ×, a
 * click outside or the form's own Cancel all call `onClose`, which discards
 * whatever was typed. Focus returns to the button that opened it, so that
 * button must stay mounted while the dialog is open.
 */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  wide = false,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  /** Two-column forms (catalogue, availability) get a wider panel. */
  wide?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  // Radix gives focus back only to a `DialogTrigger`; these dialogs open from
  // ordinary page buttons, so the button is remembered as the dialog opens
  // (before focus moves inside it) and focused again when it closes.
  const returnTo = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        closeLabel={t('admin:dialog.close')}
        className={cn(wide && 'max-w-2xl')}
        onOpenAutoFocus={() => {
          returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnTo.current?.focus()
        }}
        // Radix warns without a description; an absent one is deliberate here.
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody>
          <InDialogContext.Provider value={true}>{children}</InDialogContext.Provider>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
