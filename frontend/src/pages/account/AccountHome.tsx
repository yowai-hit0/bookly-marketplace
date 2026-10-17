import { CircleAlert, LogOut, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { forgetAccountMe, useAccount } from '@/auth/account'
import { useSignOut } from '@/auth/useSignOut'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { container, data, eyebrow, pageTitle, pageY } from '@/pages/client/classes'

/**
 * `/account`, minimal for now (Phase 2 brief decision 10; Phase 8 builds the
 * dashboard): a greeting with the client's name, the address they sign in
 * with, and sign out. Guarded by the account session in `routes.tsx`.
 */
export function AccountHome() {
  const { t } = useTranslation()
  const leave = useSignOut('account')
  const [attempt, setAttempt] = useState(0)
  const account = useAccount(attempt)

  function signOut() {
    forgetAccountMe()
    leave('/')
  }

  return (
    <main className={cn(container, pageY, 'flex justify-center')}>
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xs border p-6 text-pretty sm:p-8">
        <p className={eyebrow}>
          <UserRound aria-hidden="true" />
          {t('auth:eyebrow.account')}
        </p>

        {account.state === 'ready' ? (
          <>
            <h1 className={cn(pageTitle, 'wrap-anywhere')}>
              {account.user.fullName !== null && account.user.fullName.trim() !== ''
                ? t('account:home.greeting', { name: account.user.fullName.trim() })
                : t('account:home.greetingNoName')}
            </h1>
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground font-mono text-xs font-medium tracking-[0.1em] uppercase">{t('account:home.email')}</p>
              <p className={cn(data, 'wrap-anywhere')}>{account.user.email}</p>
            </div>
          </>
        ) : (
          <>
            <h1 className={pageTitle}>{t('account:home.greetingNoName')}</h1>
            {account.state === 'failed' ? (
              <div className="flex flex-col items-start gap-3">
                <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
                  <p>{t('account:home.loadFailed')}</p>
                </Callout>
                <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  {t('account:home.retry')}
                </Button>
              </div>
            ) : (
              <div aria-busy="true" className="flex flex-col gap-2">
                <p className="sr-only" role="status">
                  {t('account:home.loading')}
                </p>
                <Skeleton aria-hidden="true" className="h-3 w-16" />
                <Skeleton aria-hidden="true" className="h-5 w-56 max-w-full" />
              </div>
            )}
          </>
        )}

        <Button variant="outline" className="self-start" onClick={signOut}>
          <LogOut aria-hidden="true" />
          {t('account:home.signOut')}
        </Button>
      </div>
    </main>
  )
}
