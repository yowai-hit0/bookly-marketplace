import { createContext, useContext } from 'react'

/**
 * True inside a `FormDialog`. A shared form (EntityForm, BlockForm,
 * WorkingHoursForm) then drops its own heading and panel frame, because the
 * dialog already gives it a title and a surface.
 */
export const InDialogContext = createContext(false)

export function useInDialog(): boolean {
  return useContext(InDialogContext)
}
