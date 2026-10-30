import { ArrowDown, ArrowUp, Check, CircleAlert, Eye, EyeOff, Lock, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  NAME_MAX,
  type PlatformCategory,
  SLUG_MAX,
  movedCategory,
  nameProblem,
  platformCategoriesApi,
  slugFromName,
  slugProblem,
} from '@/platform/categories'
import { AdminField } from '@/pages/admin/AdminField'
import { EYEBROW, FIELD, META, PAGE, SUBPANEL } from '@/pages/admin/console/classes'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'

type Loaded = { attempt: number; categories: PlatformCategory[] } | { attempt: number; failed: true }
type Notice = { tone: 'success' | 'warning' | 'destructive'; text: string }
type Dialog =
  | { kind: 'create' }
  | { kind: 'rename'; category: PlatformCategory }
  | { kind: 'deactivate'; category: PlatformCategory }
  | { kind: 'delete'; category: PlatformCategory }

/**
 * `/platform/categories` (marketplace spec R9.2; Phase 9 user decision 3):
 * every category, active and inactive, in the order the directory shows them,
 * with how many photographers have each.
 *
 * Create and rename open a dialog (admin console 6.11); the slug is checked
 * before sending and never changes after creation (it is in shared directory
 * links), so the rename dialog shows it read-only with the reason.
 * Deactivating hides a category from the public and the studio picker while
 * its photographers keep the tag: one in use is confirmed first and says so;
 * an unused one, and any reactivation, happen at once. Delete is offered only
 * while nobody has the category, and a `409 category_in_use` race says so and
 * offers to deactivate instead. Reordering is the studio portfolio's pattern:
 * one place at a time, saved at once with every id, focus kept on the moved
 * row's button and the new place announced; a list changed elsewhere reloads.
 */
export function PlatformCategories() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ordering, setOrdering] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const focusAfterMove = useRef<{ id: string; by: -1 | 1 } | null>(null)
  const focusCreate = useRef(false)
  const createButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    platformCategoriesApi.list().then(
      (categories) => !cancelled && setLoaded({ attempt, categories }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const categories = current !== null && 'categories' in current ? current.categories : null

  // A moved category keeps focus on the button that moved it; at an end, where
  // that button is now disabled, on the other one. After a delete the row is
  // gone, so focus goes to the page's own action.
  useEffect(() => {
    const target = focusAfterMove.current
    if (target !== null) {
      focusAfterMove.current = null
      const same = document.getElementById(moveButtonId(target.id, target.by)) as HTMLButtonElement | null
      const other = document.getElementById(moveButtonId(target.id, target.by === -1 ? 1 : -1)) as HTMLButtonElement | null
      ;(same !== null && !same.disabled ? same : other)?.focus()
    }
    if (focusCreate.current) {
      focusCreate.current = false
      // After the dialog has handed focus back (to a button that no longer exists).
      setTimeout(() => createButton.current?.focus(), 0)
    }
  }, [categories])

  function setCategories(next: PlatformCategory[]) {
    setLoaded((now) => (now === null || !('categories' in now) ? now : { ...now, categories: next }))
  }

  function replace(category: PlatformCategory) {
    setLoaded((now) =>
      now === null || !('categories' in now) ? now : { ...now, categories: now.categories.map((each) => (each.id === category.id ? category : each)) },
    )
  }

  function reload(text: string, tone: Notice['tone'] = 'warning') {
    setNotice({ tone, text })
    setAttempt((n) => n + 1)
  }

  async function move(index: number, by: -1 | 1) {
    if (ordering || categories === null) return
    const before = categories
    const category = before[index]
    if (category === undefined || index + by < 0 || index + by >= before.length) return
    const next = movedCategory(before, index, by)
    setNotice(null)
    setOrdering(true)
    // Shown at once; put back if the API refuses.
    setCategories(next)
    focusAfterMove.current = { id: category.id, by }
    try {
      const result = await platformCategoriesApi.order(next.map((each) => each.id))
      if (result.status === 'saved') {
        setCategories(result.categories)
        const position = result.categories.findIndex((each) => each.id === category.id) + 1
        setAnnouncement(t('platform:categories.moved', { name: category.nameEn, position, count: result.categories.length }))
      } else if (result.status === 'changed') {
        reload(t('platform:categories.orderChanged'))
      } else {
        setCategories(before)
        setNotice({ tone: 'destructive', text: t('platform:categories.orderFailed') })
      }
    } catch (error) {
      if (error instanceof UnauthenticatedError) return
      setCategories(before)
      setNotice({ tone: 'destructive', text: t('platform:categories.orderFailed') })
    } finally {
      setOrdering(false)
    }
  }

  /** Deactivate an unused category, or reactivate any, at once: the same button stays focused, its word flips. */
  async function toggle(category: PlatformCategory) {
    if (toggling !== null) return
    setNotice(null)
    setToggling(category.id)
    try {
      const result = await platformCategoriesApi.update(category.id, { isActive: !category.isActive })
      if (result.status === 'saved') {
        replace(result.category)
        setNotice({
          tone: 'success',
          text: t(result.category.isActive ? 'platform:categories.reactivated' : 'platform:categories.deactivated', { name: result.category.nameEn }),
        })
      } else if (result.status === 'gone') {
        reload(t('platform:categories.gone'))
      } else {
        setNotice({ tone: 'destructive', text: t('platform:categories.failed') })
      }
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setNotice({ tone: 'destructive', text: t('platform:categories.failed') })
    } finally {
      setToggling(null)
    }
  }

  const open = (next: Dialog) => {
    setNotice(null)
    setDialog(next)
  }

  return (
    <main className={cn(PAGE, 'max-w-4xl')}>
      <PageHeader
        eyebrow={t('platform:nav.label')}
        eyebrowIcon={Tags}
        title={t('platform:categories.title')}
        badges={
          categories !== null && (
            <Badge variant="console-count" data-category-count={categories.length}>
              {t('platform:categories.count', { count: categories.length })}
            </Badge>
          )
        }
        actions={
          categories !== null && (
            <Button ref={createButton} size="console" onClick={() => open({ kind: 'create' })}>
              <Plus aria-hidden="true" />
              {t('platform:categories.create')}
            </Button>
          )
        }
      >
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:categories.intro')}</p>
      </PageHeader>

      {/* The move announcements: polite, and only words. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {notice !== null && (
        <Callout
          variant="console"
          tone={notice.tone}
          icon={notice.tone === 'success' ? Check : CircleAlert}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          <p>{notice.text}</p>
        </Callout>
      )}

      {current === null && (
        <LoadingRegion label={t('platform:categories.loading')} className="flex flex-col rounded-xs border">
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="flex items-center gap-4 border-b p-4 last:border-b-0 sm:px-6">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Line w="w-40 max-w-full" />
                <Line w="w-64 max-w-full" className="h-3" />
              </div>
              <Line w="w-56 max-sm:hidden" className="h-8" />
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && 'failed' in current && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:categories.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:categories.retry')}
          </Button>
        </div>
      )}

      {categories !== null && categories.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-start gap-2 rounded-xs border border-dashed p-6" data-categories-empty="">
          <Tags aria-hidden="true" className="size-5" />
          <p className="text-sm">{t('platform:categories.empty')}</p>
        </div>
      )}

      {categories !== null && categories.length > 0 && (
        <ol className="flex flex-col rounded-xs border" aria-label={t('platform:categories.title')}>
          {categories.map((category, index) => {
            const name = category.nameEn
            const busy = toggling === category.id
            return (
              <li
                key={category.id}
                data-category={category.slug}
                data-active={category.isActive}
                className="flex flex-col gap-4 border-b p-4 last:border-b-0 sm:px-6 md:flex-row md:items-center md:gap-5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <p className={cn('min-w-0 text-base wrap-anywhere', !category.isActive && 'text-muted-foreground')}>{name}</p>
                    <ActiveBadge active={category.isActive} />
                  </div>
                  <p className={cn(META, 'flex flex-wrap items-center gap-x-2 gap-y-1.5')}>
                    <span className="font-mono wrap-anywhere">{category.slug}</span>
                    <span aria-hidden="true">·</span>
                    <span data-photographer-count={category.photographerCount}>
                      {category.photographerCount === 0
                        ? t('platform:categories.noPhotographers')
                        : t('platform:categories.photographers', { count: category.photographerCount })}
                    </span>
                  </p>
                </div>
                {/* The edits, then the moves at the far right, so the arrows line up row after row; on a phone the edits take a row of their own. */}
                <div className="flex flex-wrap gap-2 md:shrink-0 md:justify-end">
                  <div className="flex flex-wrap gap-2 max-sm:basis-full [&>*]:max-sm:flex-1">
                    <Button
                      variant="console-outline"
                      size="console"
                      aria-label={t('platform:categories.renameLabel', { name })}
                      onClick={() => open({ kind: 'rename', category })}
                    >
                      <Pencil aria-hidden="true" />
                      {t('platform:categories.rename')}
                    </Button>
                    <Button
                      variant="console-outline"
                      size="console"
                      aria-label={t(category.isActive ? 'platform:categories.deactivateLabel' : 'platform:categories.reactivateLabel', { name })}
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (busy) return
                        if (category.isActive && category.photographerCount > 0) open({ kind: 'deactivate', category })
                        else void toggle(category)
                      }}
                    >
                      {category.isActive ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      {t(category.isActive ? 'platform:categories.deactivate' : 'platform:categories.reactivate')}
                    </Button>
                    {category.photographerCount === 0 && (
                      <Button
                        variant="console-outline"
                        size="console"
                        className="text-destructive hover:text-destructive"
                        aria-label={t('platform:categories.deleteLabel', { name })}
                        onClick={() => open({ kind: 'delete', category })}
                      >
                        <Trash2 aria-hidden="true" />
                        {t('platform:categories.delete')}
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      id={moveButtonId(category.id, -1)}
                      variant="console-outline"
                      size="console-icon"
                      aria-label={t('platform:categories.moveUpLabel', { name })}
                      title={t('platform:categories.moveUp')}
                      disabled={index === 0}
                      aria-disabled={ordering || undefined}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      id={moveButtonId(category.id, 1)}
                      variant="console-outline"
                      size="console-icon"
                      aria-label={t('platform:categories.moveDownLabel', { name })}
                      title={t('platform:categories.moveDown')}
                      disabled={index === categories.length - 1}
                      aria-disabled={ordering || undefined}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <FormDialog open={dialog?.kind === 'create'} onClose={() => setDialog(null)} title={t('platform:categories.createTitle')}>
        {dialog?.kind === 'create' && (
          <CreateForm
            onCancel={() => setDialog(null)}
            onCreated={(category) => {
              setDialog(null)
              setCategories([...(categories ?? []), category])
              setNotice({ tone: 'success', text: t('platform:categories.created', { name: category.nameEn }) })
            }}
          />
        )}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === 'rename'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'rename' ? t('platform:categories.renameTitle', { name: dialog.category.nameEn }) : ''}
      >
        {dialog?.kind === 'rename' && (
          <RenameForm
            key={dialog.category.id}
            category={dialog.category}
            onCancel={() => setDialog(null)}
            onSaved={(category) => {
              setDialog(null)
              replace(category)
              setNotice({ tone: 'success', text: t('platform:categories.renamed', { name: category.nameEn }) })
            }}
            onGone={() => {
              setDialog(null)
              reload(t('platform:categories.gone'))
            }}
          />
        )}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === 'deactivate'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'deactivate' ? t('platform:categories.deactivateTitle', { name: dialog.category.nameEn }) : ''}
        description={dialog?.kind === 'deactivate' ? t('platform:categories.deactivateBody', { count: dialog.category.photographerCount }) : undefined}
      >
        {dialog?.kind === 'deactivate' && (
          <DeactivateForm
            key={dialog.category.id}
            category={dialog.category}
            onCancel={() => setDialog(null)}
            onSaved={(category) => {
              setDialog(null)
              replace(category)
              setNotice({ tone: 'success', text: t('platform:categories.deactivated', { name: category.nameEn }) })
            }}
            onGone={() => {
              setDialog(null)
              reload(t('platform:categories.gone'))
            }}
          />
        )}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === 'delete'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'delete' ? t('platform:categories.deleteTitle', { name: dialog.category.nameEn }) : ''}
        description={dialog?.kind === 'delete' && dialog.category.photographerCount === 0 ? t('platform:categories.deleteBody') : undefined}
      >
        {dialog?.kind === 'delete' && (
          <DeleteForm
            key={dialog.category.id}
            category={dialog.category}
            onCancel={() => setDialog(null)}
            onDeleted={() => {
              setDialog(null)
              focusCreate.current = true
              setCategories((categories ?? []).filter((each) => each.id !== dialog.category.id))
              setNotice({ tone: 'success', text: t('platform:categories.deleted', { name: dialog.category.nameEn }) })
            }}
            onInUse={(photographerCount) => {
              const now = { ...dialog.category, photographerCount }
              replace(now)
              // The same dialog (its form keeps its state), no longer saying nobody has it.
              setDialog({ kind: 'delete', category: now })
            }}
            onDeactivated={(category) => {
              setDialog(null)
              replace(category)
              setNotice({ tone: 'success', text: t('platform:categories.deactivated', { name: category.nameEn }) })
            }}
            onGone={() => {
              setDialog(null)
              focusCreate.current = true
              reload(t('platform:categories.gone'))
            }}
          />
        )}
      </FormDialog>
    </main>
  )
}

function moveButtonId(id: string, by: -1 | 1): string {
  return `category-${by === -1 ? 'up' : 'down'}-${id}`
}

/** Active is the success tint with a check; inactive a dotted edge, muted, with a closed eye: the word always shown. */
function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation()
  return active ? (
    <Badge variant="console-success">
      <Check aria-hidden="true" />
      {t('platform:categories.active')}
    </Badge>
  ) : (
    <Badge variant="console" className="border-input text-muted-foreground border border-dotted bg-transparent">
      <EyeOff aria-hidden="true" />
      {t('platform:categories.inactive')}
    </Badge>
  )
}

/** Cancel first in the DOM, the action last. */
function DialogActions({
  busy,
  label,
  busyLabel,
  onCancel,
  destructive = false,
}: {
  busy: boolean
  label: string
  busyLabel: string
  onCancel: () => void
  destructive?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
        {t('platform:categories.cancel')}
      </Button>
      <Button type="submit" size="console" variant={destructive ? 'console-destructive-solid' : 'default'} disabled={busy}>
        {busy ? busyLabel : label}
      </Button>
    </div>
  )
}

function FailedLine({ text }: { text: string }) {
  return (
    <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  )
}

type NameError = 'required' | 'long' | null
type SlugError = 'required' | 'format' | 'long' | 'taken' | null

function nameErrorText(t: ReturnType<typeof useTranslation>['t'], error: NameError): string | null {
  return error === 'required' ? t('platform:categories.errors.nameRequired') : error === 'long' ? t('platform:categories.errors.nameLong') : null
}

function NameField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: NameError }) {
  const { t } = useTranslation()
  return (
    <AdminField label={t('platform:categories.fields.nameEn')} hint={t('platform:categories.hints.nameEn')} error={nameErrorText(t, error)}>
      {(props) => (
        <Input
          {...props}
          name="nameEn"
          autoComplete="off"
          required
          // A little room past the cap, so a paste is not cut silently; the count is checked on save.
          maxLength={NAME_MAX * 2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={FIELD}
        />
      )}
    </AdminField>
  )
}

/** A new category: its name, and a slug that follows the name until it is typed by hand. */
function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (category: PlatformCategory) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [nameError, setNameError] = useState<NameError>(null)
  const [slugError, setSlugError] = useState<SlugError>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    const badName = nameProblem(name)
    const badSlug = slugProblem(slug)
    setNameError(badName)
    setSlugError(badSlug)
    if (badName !== null || badSlug !== null) return
    setBusy(true)
    try {
      const result = await platformCategoriesApi.create(slug, name)
      if (result.status === 'created') onCreated(result.category)
      else if (result.status === 'slug_taken') setSlugError('taken')
      else if (result.status === 'invalid') {
        if (result.fields.includes('slug')) setSlugError(slug.trim().length > SLUG_MAX ? 'long' : 'format')
        if (result.fields.includes('nameEn')) setNameError('long')
      } else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const slugErrorText =
    slugError === 'required'
      ? t('platform:categories.errors.slugRequired')
      : slugError === 'format'
        ? t('platform:categories.errors.slugFormat')
        : slugError === 'long'
          ? t('platform:categories.errors.slugLong')
          : slugError === 'taken'
            ? t('platform:categories.errors.slugTaken')
            : null

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      <NameField
        value={name}
        error={nameError}
        onChange={(next) => {
          setName(next)
          if (!slugTouched) setSlug(slugFromName(next))
        }}
      />
      <AdminField label={t('platform:categories.fields.slug')} hint={t('platform:categories.hints.slug')} error={slugErrorText}>
        {(props) => (
          <Input
            {...props}
            name="slug"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={SLUG_MAX * 2}
            value={slug}
            onChange={(event) => {
              setSlugTouched(true)
              setSlug(event.target.value)
            }}
            className={cn(FIELD, 'font-mono')}
          />
        )}
      </AdminField>
      {failed && <FailedLine text={t('platform:categories.failed')} />}
      <DialogActions busy={busy} label={t('platform:categories.createSubmit')} busyLabel={t('platform:categories.creating')} onCancel={onCancel} />
    </form>
  )
}

/** A new name; the slug is shown, read-only, with why it cannot change. */
function RenameForm({
  category,
  onCancel,
  onSaved,
  onGone,
}: {
  category: PlatformCategory
  onCancel: () => void
  onSaved: (category: PlatformCategory) => void
  onGone: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(category.nameEn)
  const [nameError, setNameError] = useState<NameError>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    const bad = nameProblem(name)
    setNameError(bad)
    if (bad !== null) return
    setBusy(true)
    try {
      const result = await platformCategoriesApi.update(category.id, { nameEn: name })
      if (result.status === 'saved') onSaved(result.category)
      else if (result.status === 'gone') onGone()
      else if (result.status === 'invalid') setNameError('long')
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      <NameField value={name} onChange={setName} error={nameError} />
      <div className={cn(SUBPANEL, 'gap-2 lg:p-4')} data-slug-fixed="">
        <p className={EYEBROW}>{t('platform:categories.fields.slug')}</p>
        <p className="font-mono text-[0.9375rem] wrap-anywhere">{category.slug}</p>
        <p className={cn(META, 'flex items-start gap-2 text-[0.8125rem]')}>
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('platform:categories.slugFixed')}
        </p>
      </div>
      {failed && <FailedLine text={t('platform:categories.failed')} />}
      <DialogActions busy={busy} label={t('platform:categories.renameSubmit')} busyLabel={t('platform:categories.saving')} onCancel={onCancel} />
    </form>
  )
}

/** Deactivating a category in use: the dialog's description says the photographers keep the tag. */
function DeactivateForm({
  category,
  onCancel,
  onSaved,
  onGone,
}: {
  category: PlatformCategory
  onCancel: () => void
  onSaved: (category: PlatformCategory) => void
  onGone: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    setBusy(true)
    try {
      const result = await platformCategoriesApi.update(category.id, { isActive: false })
      if (result.status === 'saved') onSaved(result.category)
      else if (result.status === 'gone') onGone()
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      {failed && <FailedLine text={t('platform:categories.failed')} />}
      <DialogActions busy={busy} label={t('platform:categories.deactivateSubmit')} busyLabel={t('platform:categories.saving')} onCancel={onCancel} />
    </form>
  )
}

/**
 * Deleting an unused category, confirmed first. If someone tagged it
 * meanwhile (`409 category_in_use`), the dialog says how many and offers to
 * deactivate it instead; the row's count follows, so Delete leaves it.
 */
function DeleteForm({
  category,
  onCancel,
  onDeleted,
  onInUse,
  onDeactivated,
  onGone,
}: {
  category: PlatformCategory
  onCancel: () => void
  onDeleted: () => void
  onInUse: (photographerCount: number) => void
  onDeactivated: (category: PlatformCategory) => void
  onGone: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [inUse, setInUse] = useState<number | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || inUse !== null) return
    setFailed(false)
    setBusy(true)
    try {
      const result = await platformCategoriesApi.remove(category.id)
      if (result.status === 'deleted') onDeleted()
      else if (result.status === 'in_use') {
        setInUse(result.photographerCount)
        onInUse(result.photographerCount)
      } else if (result.status === 'gone') onGone()
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function deactivateInstead() {
    if (busy) return
    setFailed(false)
    setBusy(true)
    try {
      const result = await platformCategoriesApi.update(category.id, { isActive: false })
      if (result.status === 'saved') onDeactivated(result.category)
      else if (result.status === 'gone') onGone()
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (inUse !== null) {
    return (
      <div className="flex flex-col gap-5">
        <Callout variant="console" tone="warning" icon={CircleAlert} role="alert" data-in-use={inUse}>
          <p>{t('platform:categories.inUse', { count: inUse })}</p>
        </Callout>
        {failed && <FailedLine text={t('platform:categories.failed')} />}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
            {t('platform:categories.cancel')}
          </Button>
          {category.isActive && (
            <Button type="button" size="console" disabled={busy} onClick={() => void deactivateInstead()}>
              <EyeOff aria-hidden="true" />
              {busy ? t('platform:categories.saving') : t('platform:categories.deactivateInstead')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      {failed && <FailedLine text={t('platform:categories.failed')} />}
      <DialogActions
        busy={busy}
        destructive
        label={t('platform:categories.deleteSubmit')}
        busyLabel={t('platform:categories.deleting')}
        onCancel={onCancel}
      />
    </form>
  )
}
