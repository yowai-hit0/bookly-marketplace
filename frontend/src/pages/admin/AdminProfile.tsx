import { BellRing, Check, CircleAlert, ImageOff, Info, Lock, Search, UserRound } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { UnauthenticatedError } from '@/admin/api'
import {
  type ProfileField,
  type ProfileForm,
  type StudioProfile,
  handleChangeNotifies,
  invalidProfileFields,
  isHttpsLink,
  profileApi,
  profileForm,
  profilePatch,
} from '@/admin/profile'
import { normaliseHandle } from '@/auth/handle'
import { type ProvinceDistricts, type PublicCategory, fetchCategories, fetchDistricts } from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { CHOICE, EYEBROW, FIELD, META, PAGE, SECTION_TITLE, TEXTAREA } from './console/classes'
import { PageHeader } from './console/PageHeader'
import { Line, LoadingRegion } from './console/Skeletons'

type Data = { profile: StudioProfile; categories: PublicCategory[]; provinces: ProvinceDistricts[] }
type Loaded = { attempt: number; data: Data } | { attempt: number; failed: true }
type Notice = { tone: 'success' | 'info' | 'warning' | 'destructive'; text: string }
type Errors = Partial<Record<ProfileField, string>>

/** How long typing must pause before the cover preview follows the link. */
const PREVIEW_DELAY_MS = 400

/**
 * `/studio/profile` (marketplace spec R7.2): what the public profile shows --
 * the handle (read-only once the studio has been approved), the display name
 * and bio, the cover image (with a live preview of the link), the districts
 * and categories, and the public contact details.
 *
 * A save sends only what changed, checked here first where the API would
 * otherwise answer a 400 that names no field. Every refusal lands on the field
 * it is about (a taken or locked handle, a 422's named fields); after a save
 * the form is redrawn from what the API stored. `#districts` and `#categories`
 * (the setup checklist's links) bring their own fieldset into view.
 *
 * While the studio is pending and submitted for review, a line under the
 * handle says that changing it tells the platform team (Phase 7, user decision
 * 2026-10-27): the change still saves, and every platform admin is emailed.
 */
export function AdminProfile() {
  const { t } = useTranslation()
  const { hash } = useLocation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [profile, setProfile] = useState<StudioProfile | null>(null)
  const [saved, setSaved] = useState<ProfileForm | null>(null)
  const [form, setForm] = useState<ProfileForm | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [focusInvalid, setFocusInvalid] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([profileApi.load(), fetchCategories(), fetchDistricts()]).then(
      ([loadedProfile, categories, provinces]) => {
        if (cancelled) return
        setLoaded({ attempt, data: { profile: loadedProfile, categories, provinces } })
        setProfile(loadedProfile)
        setSaved(profileForm(loadedProfile))
        setForm(profileForm(loadedProfile))
      },
      (error: unknown) => {
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const data = current !== null && 'data' in current ? current.data : null
  const ready = data !== null && profile !== null && saved !== null && form !== null

  // The setup checklist links to a fieldset: bring it into view once it exists.
  useEffect(() => {
    if (!ready || (hash !== '#districts' && hash !== '#categories')) return
    const target = document.getElementById(hash.slice(1))
    target?.scrollIntoView?.({ block: 'start' })
    target?.focus({ preventScroll: true })
  }, [ready, hash])

  // After a refused save, the first field in error takes focus.
  useEffect(() => {
    if (focusInvalid === 0) return
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid-group] input')
    first?.focus()
  }, [focusInvalid])

  function update<K extends keyof ProfileForm>(field: K, value: ProfileForm[K]) {
    setForm((now) => (now === null ? now : { ...now, [field]: value }))
    setNotice(null)
  }

  function toggle(field: 'districts' | 'categories', value: string, on: boolean) {
    if (form === null) return
    const next = new Set(form[field])
    if (on) next.add(value)
    else next.delete(value)
    update(field, next)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || profile === null || saved === null || form === null) return
    setNotice(null)
    const patch = profilePatch(saved, form, profile.handleEditable)
    if (Object.keys(patch).length === 0) {
      setErrors({})
      setNotice({ tone: 'info', text: t('admin:profile.noChanges') })
      return
    }
    const invalid = invalidProfileFields(patch)
    if (invalid.length > 0) {
      setErrors(errorsFor(invalid))
      setFocusInvalid((n) => n + 1)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      const result = await profileApi.save(patch)
      if (result.status === 'saved') {
        setProfile(result.profile)
        setSaved(profileForm(result.profile))
        setForm(profileForm(result.profile))
        setNotice({ tone: 'success', text: t('admin:profile.saved') })
      } else if (result.status === 'invalid') {
        if (result.handle === 'locked') {
          // Approved meanwhile: the handle is fixed now. Put it back and say why.
          setProfile({ ...profile, handleEditable: false })
          setForm({ ...form, handle: saved.handle })
          setNotice({ tone: 'warning', text: t('admin:profile.errors.handleLocked') })
          setErrors(errorsFor(result.fields.filter((field) => field !== 'handle')))
        } else {
          setErrors(errorsFor(result.fields, result.handle === 'taken'))
          setFocusInvalid((n) => n + 1)
        }
      } else {
        setNotice({ tone: 'destructive', text: result.status === 'unreadable' ? t('admin:profile.invalid') : t('admin:profile.saveFailed') })
      }
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setNotice({ tone: 'destructive', text: t('admin:profile.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  function errorsFor(fields: readonly ProfileField[], handleTaken = false): Errors {
    const next: Errors = {}
    for (const field of fields) {
      next[field] =
        field === 'handle'
          ? handleTaken
            ? t('auth:signup.errors.handleTaken')
            : t('auth:signup.errors.handle')
          : t(`admin:profile.errors.${field}`)
    }
    return next
  }

  return (
    <main className={cn(PAGE, 'max-w-3xl')}>
      <PageHeader eyebrow={t('studio:nav.label')} eyebrowIcon={UserRound} title={t('admin:profile.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:profile.intro')}</p>
      </PageHeader>

      {current === null && <ProfileSkeleton label={t('admin:profile.loading')} />}

      {current !== null && 'failed' in current && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:profile.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:profile.retry')}
          </Button>
        </div>
      )}

      {ready && (
        <form
          ref={formRef}
          className="flex flex-col"
          aria-label={t('admin:profile.title')}
          noValidate
          onSubmit={(event) => void onSubmit(event)}
        >
          <Section title={t('admin:profile.sections.about')} first>
            <HandleField
              value={form.handle}
              editable={profile.handleEditable}
              notifies={handleChangeNotifies(profile)}
              error={errors.handle ?? null}
              onChange={(value) => update('handle', value)}
            />
            <AdminField label={t('admin:profile.fields.displayName')} hint={t('admin:profile.hints.displayName')} error={errors.displayName ?? null}>
              {(props) => (
                <Input
                  {...props}
                  name="displayName"
                  autoComplete="organization"
                  value={form.displayName}
                  onChange={(event) => update('displayName', event.target.value)}
                  className={FIELD}
                />
              )}
            </AdminField>
            <AdminField label={t('admin:profile.fields.bio')} hint={t('admin:profile.hints.bio')} error={errors.bio ?? null}>
              {(props) => (
                <Textarea
                  {...props}
                  name="bio"
                  rows={6}
                  value={form.bio}
                  onChange={(event) => update('bio', event.target.value)}
                  className={TEXTAREA}
                />
              )}
            </AdminField>
          </Section>

          <Section title={t('admin:profile.sections.cover')}>
            <CoverField value={form.coverImageUrl} error={errors.coverImageUrl ?? null} onChange={(value) => update('coverImageUrl', value)} />
          </Section>

          <Section id="districts" title={t('admin:profile.sections.districts')}>
            <DistrictPicker
              provinces={data.provinces}
              selected={form.districts}
              error={errors.districts ?? null}
              onToggle={(code, on) => toggle('districts', code, on)}
            />
          </Section>

          <Section id="categories" title={t('admin:profile.sections.categories')}>
            <ChoiceGroup
              legend={t('admin:profile.sections.categories')}
              hint={t('admin:profile.hints.categories')}
              error={errors.categories ?? null}
              count={form.categories.size}
            >
              {data.categories.length === 0 ? (
                <p className={META}>{t('admin:profile.noCategories')}</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 lg:grid-cols-3">
                  {data.categories.map((category) => (
                    <Choice
                      key={category.slug}
                      name="categories"
                      value={category.slug}
                      label={category.name}
                      checked={form.categories.has(category.slug)}
                      onChange={(on) => toggle('categories', category.slug, on)}
                    />
                  ))}
                </div>
              )}
            </ChoiceGroup>
          </Section>

          <Section title={t('admin:profile.sections.contact')} intro={t('admin:profile.sections.contactHint')}>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {(['contactPhone', 'whatsappPhone'] as const).map((field) => (
                <AdminField key={field} label={t(`admin:profile.fields.${field}`)} hint={t(`admin:profile.hints.${field}`)} error={errors[field] ?? null}>
                  {(props) => (
                    <Input
                      {...props}
                      name={field}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={form[field]}
                      onChange={(event) => update(field, event.target.value)}
                      className={cn(FIELD, 'tabular-nums')}
                    />
                  )}
                </AdminField>
              ))}
              <AdminField
                className="sm:col-span-2"
                label={t('admin:profile.fields.contactEmail')}
                hint={t('admin:profile.hints.contactEmail')}
                error={errors.contactEmail ?? null}
              >
                {(props) => (
                  <Input
                    {...props}
                    name="contactEmail"
                    type="email"
                    autoComplete="email"
                    value={form.contactEmail}
                    onChange={(event) => update('contactEmail', event.target.value)}
                    className={cn(FIELD, 'sm:max-w-md')}
                  />
                )}
              </AdminField>
            </div>
          </Section>

          {/* The confirmation, the error and the button share one region under
              a hairline, so a notice only pushes the button down. */}
          <div className="flex flex-col gap-4 border-t pt-8">
            {notice !== null && (
              <Callout
                variant="console"
                tone={notice.tone}
                icon={notice.tone === 'success' ? Check : notice.tone === 'info' ? Info : CircleAlert}
                role={notice.tone === 'success' || notice.tone === 'info' ? 'status' : 'alert'}
              >
                <p>{notice.text}</p>
              </Callout>
            )}
            <Button type="submit" size="console" className="sm:min-w-36 sm:self-start" disabled={saving}>
              {saving ? t('admin:profile.saving') : t('admin:profile.save')}
            </Button>
          </div>
        </form>
      )}
    </main>
  )
}

/** One part of the form: a heading, then its fields, split from the next by a hairline. */
function Section({
  id,
  title,
  intro,
  first = false,
  children,
}: {
  id?: string
  title: string
  intro?: string
  first?: boolean
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      id={id}
      // A link target (`#districts`) takes focus without a ring: it is a place, not a control.
      tabIndex={id === undefined ? undefined : -1}
      aria-labelledby={headingId}
      className={cn('flex scroll-mt-20 flex-col gap-5 outline-none', first ? 'pb-8' : 'border-t py-8')}
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={headingId} className={SECTION_TITLE}>
          {title}
        </h2>
        {intro !== undefined && <p className={META}>{intro}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * The handle: an input until the studio is approved, then read-only with the
 * reason beside it. Under review, it also says a change notifies the platform.
 */
function HandleField({
  value,
  editable,
  notifies,
  error,
  onChange,
}: {
  value: string
  editable: boolean
  notifies: boolean
  error: string | null
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const previewId = useId()
  const normalised = normaliseHandle(value)
  return (
    <AdminField label={t('admin:profile.fields.handle')} hint={editable ? t('admin:profile.hints.handle') : undefined} error={error}>
      {(props) => (
        <>
          <Input
            {...props}
            aria-describedby={[previewId, props['aria-describedby']].filter(Boolean).join(' ')}
            name="handle"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={60}
            readOnly={!editable}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={cn(FIELD, 'font-mono sm:max-w-sm', !editable && 'text-muted-foreground bg-console-surface cursor-default')}
          />
          <div id={previewId} className="text-muted-foreground flex flex-col gap-1.5 text-[0.8125rem] leading-snug">
            {normalised !== '' && <p className="wrap-anywhere">{t('auth:signup.handlePreview', { path: `/p/${normalised}` })}</p>}
            {!editable && (
              <p className="flex items-start gap-1.5">
                <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{t('admin:profile.handleLocked')}</span>
              </p>
            )}
            {editable && notifies && (
              <p className="flex items-start gap-1.5" data-handle-notifies="">
                <BellRing aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{t('admin:profile.handleNotifies')}</span>
              </p>
            )}
          </div>
        </>
      )}
    </AdminField>
  )
}

/**
 * The cover link with a preview that follows it once typing pauses: only an
 * https link is drawn, with no referrer sent, and an image that will not load
 * says so instead of showing a broken icon.
 */
function CoverField({ value, error, onChange }: { value: string; error: string | null; onChange: (value: string) => void }) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(value)
  const [broken, setBroken] = useState<string | null>(null)

  useEffect(() => {
    if (value === shown) return
    const timer = setTimeout(() => setShown(value), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [value, shown])

  const src = isHttpsLink(shown) ? shown.trim() : null

  return (
    <div className="flex flex-col gap-4">
      <AdminField label={t('admin:profile.fields.coverImageUrl')} hint={t('admin:profile.hints.coverImageUrl')} error={error}>
        {(props) => (
          <Input
            {...props}
            name="coverImageUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={cn(FIELD, 'font-mono')}
          />
        )}
      </AdminField>
      {src !== null && (
        <figure className="flex flex-col gap-2" data-cover-preview="">
          <figcaption className={EYEBROW}>{t('admin:profile.coverPreview')}</figcaption>
          {broken === src ? (
            <div
              role="status"
              className="bg-console-surface text-muted-foreground flex aspect-[21/9] w-full flex-col items-center justify-center gap-2 rounded-xs border px-4 text-center text-sm"
            >
              <ImageOff aria-hidden="true" className="size-5" />
              {t('admin:profile.coverBroken')}
            </div>
          ) : (
            <img
              key={src}
              src={src}
              alt={t('admin:profile.coverPreview')}
              referrerPolicy="no-referrer"
              className="bg-console-surface aspect-[21/9] w-full rounded-xs border object-cover"
              onError={() => setBroken(src)}
            />
          )}
        </figure>
      )}
    </div>
  )
}

/** A labelled set of checkboxes, its rule and error said once for the whole set. */
function ChoiceGroup({
  legend,
  hint,
  error,
  count,
  children,
}: {
  legend: string
  hint: string
  error: string | null
  count: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const hintId = useId()
  const errorId = useId()
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      aria-describedby={[hintId, error === null ? null : errorId].filter(Boolean).join(' ')}
      {...(error === null ? {} : { 'data-invalid-group': '' })}
    >
      {/* The section's heading names the set visually; the legend names it for assistive tech. */}
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p id={hintId} className="text-muted-foreground text-[0.8125rem] leading-snug">
          {hint}
        </p>
        <p className={cn(EYEBROW, 'tabular-nums')} aria-live="polite">
          {t('admin:profile.selected', { count })}
        </p>
      </div>
      {error !== null && (
        <p id={errorId} className="text-destructive flex items-start gap-1.5 text-[0.8125rem] leading-snug">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {children}
    </fieldset>
  )
}

/** One checkbox and its words, the whole row a 44px target. */
function Choice({
  name,
  value,
  label,
  checked,
  onChange,
}: {
  name: string
  value: string
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-base lg:min-h-9 pointer-coarse:min-h-11">
      <input
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={cn(CHOICE, 'shrink-0 cursor-pointer')}
      />
      <span className="min-w-0 wrap-anywhere">{label}</span>
    </label>
  )
}

/**
 * Thirty districts in five provinces: a search box narrows the list as typed
 * (the ticked ones stay ticked while hidden), and each province is its own
 * labelled group.
 */
function DistrictPicker({
  provinces,
  selected,
  error,
  onToggle,
}: {
  provinces: ProvinceDistricts[]
  selected: ReadonlySet<string>
  error: string | null
  onToggle: (code: string, on: boolean) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const searchId = useId()
  const needle = query.trim().toLowerCase()
  const shown = provinces
    .map((province) => ({ ...province, districts: province.districts.filter((district) => district.name.toLowerCase().includes(needle)) }))
    .filter((province) => province.districts.length > 0)

  return (
    <ChoiceGroup legend={t('admin:profile.sections.districts')} hint={t('admin:profile.hints.districts')} error={error} count={selected.size}>
      <div className="flex flex-col gap-2">
        <label htmlFor={searchId} className="text-sm font-medium">
          {t('admin:profile.districtSearch')}
        </label>
        <div className="relative sm:max-w-sm">
          <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            id={searchId}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter in a search box would submit the whole form.
              if (event.key === 'Enter') event.preventDefault()
            }}
            className={cn(FIELD, 'pl-9')}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={META} role="status">
          {t('admin:profile.districtNoMatch', { query: query.trim() })}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {shown.map((province) => (
            <fieldset key={province.code} className="flex min-w-0 flex-col gap-1">
              <legend className={cn(EYEBROW, 'mb-1')}>{province.name}</legend>
              <div className="grid grid-cols-2 gap-x-4 lg:grid-cols-3">
                {province.districts.map((district) => (
                  <Choice
                    key={district.code}
                    name="districts"
                    value={district.code}
                    label={district.name}
                    checked={selected.has(district.code)}
                    onChange={(on) => onToggle(district.code, on)}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </ChoiceGroup>
  )
}

/** The form's shape while it loads: the sections and their fields, as placeholders. */
function ProfileSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="flex flex-col">
      {[3, 1, 6, 3].map((fields, section) => (
        <div key={section} className={cn('flex flex-col gap-5', section === 0 ? 'pb-8' : 'border-t py-8')}>
          <Line w="w-40" className="h-6" />
          {Array.from({ length: fields }, (_, field) => (
            <div key={field} className="flex flex-col gap-2">
              <Line w="w-28" />
              <Skeleton className="h-11 w-full rounded-xs lg:h-10" />
            </div>
          ))}
        </div>
      ))}
    </LoadingRegion>
  )
}
