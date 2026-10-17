import { CircleAlert, MailCheck, TriangleAlert, UserRound } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useAdminTheme } from '@/admin/theme'
import type { Area } from '@/auth/session'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AdminAuthFrame } from '@/pages/admin/console/AuthFrame'
import { FIELD, QUIET_LINK } from '@/pages/admin/console/classes'
import { container, eyebrow, pageTitle, pageY, textLink } from '@/pages/client/classes'
import { type Look, lookOf } from './look'

/**
 * The pieces every sign-in, sign-up, verify and reset page is built from, in
 * the look of the area it belongs to (Phase 2 brief decision 10):
 *
 * - the studio and the platform are consoles: the centred console panel of
 *   `design-system/bookly/admin-console.md` 6.8, outside any shell, with the
 *   console theme;
 * - the account belongs to the client site: the narrow centred panel of
 *   `client-front.md` 8.5, inside the client shell, which applies its theme.
 *
 * The pages themselves are written once, against these.
 */

/** The panel, its eyebrow, the page's only `h1` and an optional intro. */
export function AuthFrame({ area, title, intro, children }: { area: Area; title: string; intro?: ReactNode; children: ReactNode }) {
  return lookOf(area) === 'console' ? (
    <ConsoleFrame area={area} title={title} intro={intro}>
      {children}
    </ConsoleFrame>
  ) : (
    <ClientFrame title={title} intro={intro}>
      {children}
    </ClientFrame>
  )
}

function ConsoleFrame({ area, title, intro, children }: { area: Area; title: string; intro?: ReactNode; children: ReactNode }) {
  // The console theme (stored or system) applies here too; there is no toggle.
  useAdminTheme()
  const { t } = useTranslation()
  return (
    <AdminAuthFrame title={title} intro={intro} eyebrow={area === 'platform' ? t('auth:eyebrow.platform') : undefined}>
      {children}
    </AdminAuthFrame>
  )
}

function ClientFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <main className={cn(container, pageY, 'flex justify-center')}>
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xs border p-6 text-pretty sm:p-8">
        <div className="flex flex-col gap-2">
          <p className={eyebrow}>
            <UserRound aria-hidden="true" />
            {t('auth:eyebrow.account')}
          </p>
          <h1 className={cn(pageTitle, 'wrap-break-word')}>{title}</h1>
          {intro !== undefined && <p className="text-subtle-foreground">{intro}</p>}
        </div>
        {children}
      </div>
    </main>
  )
}

/** A text input in the area's field style. */
export function AuthInput({ look, className, ...props }: ComponentProps<typeof Input> & { look: Look }) {
  return <Input {...props} className={cn(look === 'console' && FIELD, className)} />
}

/** The form's one primary action, full width. */
export function SubmitButton({ look, busy, children }: { look: Look; busy: boolean; children: ReactNode }) {
  return look === 'console' ? (
    <Button type="submit" size="console" className="w-full" disabled={busy}>
      {children}
    </Button>
  ) : (
    <Button type="submit" className="client:h-12 w-full" disabled={busy}>
      {children}
    </Button>
  )
}

/** A standalone secondary link (forgot password, back to sign in, create an account). */
export function AuthLink({ look, to, children }: { look: Look; to: string; children: ReactNode }) {
  return (
    <Link to={to} className={look === 'console' ? QUIET_LINK : cn(textLink, 'self-start text-sm')}>
      {children}
    </Link>
  )
}

/** A refusal or failure under the form. `dead` marks one only a new link fixes. */
export function FormAlert({ dead = false, children }: { dead?: boolean; children: ReactNode }) {
  const Icon = dead ? TriangleAlert : CircleAlert
  return (
    <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/**
 * "We sent it" -- the same words, icon and colour for every address, because
 * the page is never told which addresses have accounts. Information, not
 * success: nothing here says an email was really sent.
 */
export function SentNotice({ look, title, children }: { look: Look; title?: string; children: ReactNode }) {
  if (look === 'client') {
    return (
      <Callout variant="console" tone="info" icon={MailCheck} role="status">
        {title !== undefined && <p className="font-medium">{title}</p>}
        <p>{children}</p>
      </Callout>
    )
  }
  return (
    <div className="flex items-start gap-2 text-sm" role="status">
      <MailCheck aria-hidden="true" className="text-console-link mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        {title !== undefined && <p className="font-medium">{title}</p>}
        <p>{children}</p>
      </div>
    </div>
  )
}
