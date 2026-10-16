import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { type ThemePreference, nextPreference } from '@/lib/theme'

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const

/**
 * The client's System / Light / Dark control (design-system/bookly/
 * client-front.md section 1): one button that cycles System, Light, Dark.
 *
 * Not radios, unlike the admin's toggle: the e2e suite counts radios page-wide
 * (the checkout page has exactly one), so a radio group in the header would
 * break it. The name says the current setting and the icon shows it; each
 * press moves to the next.
 */
export function ThemeButton({
  preference,
  onChange,
}: {
  preference: ThemePreference
  onChange: (preference: ThemePreference) => void
}) {
  const { t } = useTranslation()
  const Icon = ICONS[preference]
  const label = t(`shell:theme.${preference}`)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => onChange(nextPreference(preference))}
      className="text-subtle-foreground hover:text-foreground"
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
