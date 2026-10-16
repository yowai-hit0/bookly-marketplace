import { CircleAlert } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { apiUrl } from '@/admin/api'
import { saveSession } from '@/admin/session'
import { useAdminTheme } from '@/admin/theme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AdminAuthFrame } from './console/AuthFrame'
import { FIELD, QUIET_LINK } from './console/classes'

type Status = 'idle' | 'submitting' | 'invalid' | 'failed'

type LoginResponse = { token: string; expiresAt: string }

/**
 * Email and password (spec A-11). The API answers an unknown email, a wrong
 * password and a locked account identically, so this page cannot and does not
 * tell them apart.
 *
 * It no longer wears the client top bar (user decision, 2026-09-26, reversing
 * the 2026-09-25 one): sign in and reset password are one place, the console
 * panel below, and the Bookly mark in it is the way back to the client site.
 */
export function AdminLogin() {
  // The admin theme (stored or system) applies here too; there is no toggle.
  useAdminTheme()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [status, setStatus] = useState<Status>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setStatus('submitting')

    try {
      const res = await fetch(apiUrl('/admin/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      })
      if (res.status === 400 || res.status === 401) {
        setStatus('invalid')
        return
      }
      if (!res.ok) {
        setStatus('failed')
        return
      }
      const body = (await res.json()) as LoginResponse
      saveSession({ token: body.token, expiresAt: body.expiresAt })
      navigate('/admin/calendar', { replace: true })
    } catch {
      setStatus('failed')
    }
  }

  const message =
    status === 'invalid' ? t('admin:signIn.invalid') : status === 'failed' ? t('admin:signIn.failed') : null

  return (
    <AdminAuthFrame title={t('admin:signIn.title')}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="admin-email">{t('admin:signIn.email')}</Label>
          <Input id="admin-email" name="email" type="email" autoComplete="username" required className={FIELD} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="admin-password">{t('admin:signIn.password')}</Label>
          <Input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={FIELD}
          />
        </div>
        {message !== null && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{message}</span>
          </p>
        )}
        <Button type="submit" size="console" className="w-full" disabled={status === 'submitting'}>
          {status === 'submitting' ? t('admin:signIn.submitting') : t('admin:signIn.submit')}
        </Button>
        {/* The reset page asks for the address itself; this link carries nothing. */}
        <Link to="/admin/reset-password" className={QUIET_LINK}>
          {t('admin:signIn.forgot')}
        </Link>
      </form>
    </AdminAuthFrame>
  )
}
