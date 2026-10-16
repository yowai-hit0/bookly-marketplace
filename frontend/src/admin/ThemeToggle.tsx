import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { THEME_PREFERENCES, type ThemePreference } from './theme'

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const

/**
 * System / Light / Dark (design-system/bookly/admin-console.md section 1): three
 * native radios in a fieldset, so the group, each choice and the selected one
 * are announced, and the arrow keys move between them, with no script of our
 * own. The radios are visually hidden; each label shows its icon and draws the
 * focus outline the hidden radio cannot.
 */
export function ThemeToggle({
  preference,
  onChange,
  className,
}: {
  preference: ThemePreference
  onChange: (preference: ThemePreference) => void
  className?: string
}) {
  const { t } = useTranslation()

  return (
    <fieldset className={cn('flex', className)}>
      <legend className="sr-only">{t('admin:theme.label')}</legend>
      <div className="border-console-border-strong flex divide-x divide-(--console-border-strong) rounded-xs border">
        {THEME_PREFERENCES.map((option) => {
          const Icon = ICONS[option]
          const label = t(`admin:theme.${option}`)
          return (
            <label
              key={option}
              title={label}
              className={cn(
                'text-muted-foreground hover:text-foreground relative flex size-11 cursor-pointer items-center justify-center lg:size-8',
                'has-checked:bg-muted has-checked:text-foreground motion-safe:transition-colors motion-safe:duration-150',
                'has-focus-visible:outline-ring has-focus-visible:z-10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2',
              )}
            >
              <input
                type="radio"
                name="admin-theme"
                value={option}
                checked={preference === option}
                onChange={() => onChange(option)}
                aria-label={label}
                className="peer sr-only"
              />
              <Icon aria-hidden="true" className="size-4" />
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
