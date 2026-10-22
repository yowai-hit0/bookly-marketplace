import { CircleAlert, SlidersHorizontal, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DirectoryQuery, ProvinceDistricts, PublicCategory } from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDate, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SelectField, fieldError, fieldLabel } from '@/pages/client/SelectField'
import {
  type ActiveFilter,
  type FieldErrors,
  type FilterKey,
  activeFilters,
  chipOf,
  dateWindow,
  isCalendarDate,
  isWholeAmount,
  withFilters,
} from './directory-query'

/**
 * The directory's filters (`design-system/bookly/pages/directory.md`): one
 * set of four fields drawn two ways -- an inline bar from `lg`, a sheet below
 * it -- and the removable chips under them.
 *
 * The URL is the state. The bar applies a select or the date at once, and a
 * price on Enter or when its field is left; the sheet applies nothing until
 * "Show photographers". A price must be whole digits before it is sent; every
 * other judgement is the API's, and its 422 sentences sit under the fields
 * (`errors`). A field's error shows only while it still holds the refused
 * value: change it and the old complaint goes.
 */

export type FilterLists = { categories: PublicCategory[]; provinces: ProvinceDistricts[] }

/** The four fields' values as typed; empty is unset. */
type Draft = Record<FilterKey, string>

function draftOf(query: DirectoryQuery): Draft {
  return { category: query.category ?? '', district: query.district ?? '', min: query.min ?? '', max: query.max ?? '', date: query.date ?? '' }
}

/** A typed price that is neither empty nor whole digits. */
function badAmounts(draft: Draft): Set<'min' | 'max'> {
  const bad = new Set<'min' | 'max'>()
  for (const key of ['min', 'max'] as const) {
    const value = draft[key].trim()
    if (value !== '' && !isWholeAmount(value)) bad.add(key)
  }
  return bad
}

type FieldsProps = {
  draft: Draft
  onChange: (key: FilterKey, value: string) => void
  /** Leaving a price field, or Enter in one: the bar applies the prices. */
  onPriceCommit?: () => void
  /** The API's sentences (i18n keys), shown while the field still holds what it refused. */
  errors: FieldErrors
  query: DirectoryQuery
  /** Prices that are not whole digits, refused before sending. */
  badPrices: ReadonlySet<'min' | 'max'>
  lists: FilterLists | null
  layout: 'bar' | 'sheet'
}

/** The four fields, labelled, with their errors linked. */
function FilterFields({ draft, onChange, onPriceCommit, errors, query, badPrices, lists, layout }: FieldsProps) {
  const { t } = useTranslation()
  const id = useId()
  const dates = dateWindow()
  const unchanged = (key: FilterKey) => (draft[key].trim() || undefined) === query[key]
  const shown = (key: FilterKey | 'price'): string | null => {
    if (key === 'price') return errors.price !== undefined && unchanged('min') && unchanged('max') ? errors.price : null
    return errors[key] !== undefined && unchanged(key) ? (errors[key] ?? null) : null
  }

  const categoryError = shown('category')
  const districtError = shown('district')
  const priceError = shown('price')
  const minError = badPrices.has('min') ? 'directory:filters.digitsOnly' : shown('min')
  const maxError = badPrices.has('max') ? 'directory:filters.digitsOnly' : shown('max')
  const dateError = shown('date')

  const knownCategory = lists?.categories.some((category) => category.slug === draft.category) ?? false
  const knownDistrict = lists?.provinces.some((province) => province.districts.some((district) => district.code === draft.district)) ?? false

  return (
    <div
      className={cn(
        'grid gap-x-4 gap-y-5',
        layout === 'bar' && 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] items-start',
      )}
    >
      <Field id={`${id}category`} label={t('directory:filters.category')} error={categoryError}>
        <SelectField
          id={`${id}category`}
          value={draft.category}
          onChange={(event) => onChange('category', event.target.value)}
          aria-invalid={categoryError !== null || undefined}
          aria-describedby={categoryError !== null ? `${id}category-error` : undefined}
        >
          <option value="">{t('directory:filters.anyCategory')}</option>
          {lists?.categories.map((category) => (
            <option key={category.slug} value={category.slug}>
              {category.name}
            </option>
          ))}
          {/* A value from a link that is not on the list: kept, so the field says what was asked. */}
          {draft.category !== '' && !knownCategory && <option value={draft.category}>{draft.category}</option>}
        </SelectField>
      </Field>

      <Field id={`${id}district`} label={t('directory:filters.district')} error={districtError}>
        <SelectField
          id={`${id}district`}
          value={draft.district}
          onChange={(event) => onChange('district', event.target.value)}
          aria-invalid={districtError !== null || undefined}
          aria-describedby={districtError !== null ? `${id}district-error` : undefined}
        >
          <option value="">{t('directory:filters.anyDistrict')}</option>
          {lists?.provinces.map((province) => (
            <optgroup key={province.code} label={province.name}>
              {province.districts.map((district) => (
                <option key={district.code} value={district.code}>
                  {district.name}
                </option>
              ))}
            </optgroup>
          ))}
          {draft.district !== '' && !knownDistrict && <option value={draft.district}>{draft.district}</option>}
        </SelectField>
      </Field>

      <fieldset className="min-w-0" aria-describedby={priceError !== null ? `${id}price-error` : undefined}>
        <legend className={cn(fieldLabel, 'mb-1.5')}>{t('directory:filters.price')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['min', 'max'] as const).map((key) => {
            const error = key === 'min' ? minError : maxError
            const invalid = error !== null || priceError !== null
            return (
              <div key={key} className="flex min-w-0 flex-col gap-1.5">
                {/* The label sits inside the field's left edge, so the pair lines up with the other fields. */}
                <div className="relative min-w-0">
                  <label
                    htmlFor={`${id}${key}`}
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[0.8125rem]"
                  >
                    {t(`directory:filters.${key}`)}
                  </label>
                  <Input
                  id={`${id}${key}`}
                  name={key}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={t('directory:filters.any')}
                  value={draft[key]}
                  onChange={(event) => onChange(key, event.target.value)}
                  onBlur={onPriceCommit}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key !== 'Enter' || onPriceCommit === undefined) return
                    event.preventDefault()
                    onPriceCommit()
                  }}
                  aria-invalid={invalid || undefined}
                  aria-describedby={error !== null ? `${id}${key}-error` : undefined}
                  className="rounded-xs font-mono tabular-nums placeholder:font-sans client:pl-18"
                />
                </div>
                {error !== null && (
                  <p id={`${id}${key}-error`} className={fieldError}>
                    <CircleAlert aria-hidden="true" />
                    {t(error)}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        {priceError !== null && (
          <p id={`${id}price-error`} className={fieldError}>
            <CircleAlert aria-hidden="true" />
            {t(priceError)}
          </p>
        )}
      </fieldset>

      <Field id={`${id}date`} label={t('directory:filters.date')} error={dateError}>
        <Input
          id={`${id}date`}
          type="date"
          min={dates.min}
          max={dates.max}
          value={draft.date}
          onChange={(event) => onChange('date', event.target.value)}
          aria-invalid={dateError !== null || undefined}
          aria-describedby={dateError !== null ? `${id}date-error` : undefined}
          className="rounded-xs font-mono tabular-nums"
        />
      </Field>
    </div>
  )
}

/** A label above a control, and its error under it. */
function Field({ id, label, error, children }: { id: string; label: string; error: string | null; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      {children}
      {error !== null && (
        <p id={`${id}-error`} className={fieldError}>
          <CircleAlert aria-hidden="true" />
          {t(error)}
        </p>
      )}
    </div>
  )
}

type CommitProps = {
  query: DirectoryQuery
  lists: FilterLists | null
  errors: FieldErrors
  /** Writes a new query to the URL (a history entry). */
  onCommit: (next: DirectoryQuery) => void
}

/**
 * The inline bar, from `lg`. Selects and the date apply at once; a price on
 * Enter or when its field is left, so typing an amount is one request. The
 * selects and the date read the URL directly; the two prices are a draft
 * that follows the URL whenever it moves (Back, a chip, the sheet).
 */
export function FilterBar({ query, lists, errors, onCommit }: CommitProps) {
  const { t } = useTranslation()
  const fromUrl = `${query.min ?? ''}|${query.max ?? ''}`
  const [prices, setPrices] = useState({ min: query.min ?? '', max: query.max ?? '', fromUrl })
  const [badPrices, setBadPrices] = useState<ReadonlySet<'min' | 'max'>>(new Set())
  // The URL's prices moved: the draft follows them (state derived during render, not in an effect).
  if (prices.fromUrl !== fromUrl) {
    setPrices({ min: query.min ?? '', max: query.max ?? '', fromUrl })
    setBadPrices(new Set())
  }
  const draft: Draft = { ...draftOf(query), min: prices.min, max: prices.max }

  function change(key: FilterKey, value: string) {
    if (key === 'min' || key === 'max') {
      setPrices((current) => ({ ...current, [key]: value }))
      setBadPrices((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      return
    }
    // A date is applied once it is a whole date: the field may hold a part-typed one.
    if (key === 'date' && value !== '' && !isCalendarDate(value)) return
    onCommit(withFilters(query, { [key]: value }))
  }

  function commitPrices() {
    const bad = badAmounts(draft)
    setBadPrices(bad)
    if (bad.size > 0) return
    const min = draft.min.trim()
    const max = draft.max.trim()
    if ((min || undefined) === query.min && (max || undefined) === query.max) return
    onCommit(withFilters(query, { min, max }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    commitPrices()
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={t('directory:filters.label')}
      className="bg-background hidden rounded-xs border p-5 lg:block"
      data-filter-bar=""
    >
      <FilterFields
        draft={draft}
        onChange={change}
        onPriceCommit={commitPrices}
        errors={errors}
        query={query}
        badPrices={badPrices}
        lists={lists}
        layout="bar"
      />
    </form>
  )
}

/**
 * Below `lg`: the "Filters" button, with how many filters are on, opening a
 * sheet of the same fields. Nothing applies until "Show photographers";
 * closing it any other way (Escape, the ×, the scrim) leaves the URL as it
 * was. The sheet's form mounts when it opens, so it always starts from the URL.
 */
export function FilterSheet({
  query,
  lists,
  errors,
  onCommit,
  open,
  onOpenChange,
}: CommitProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const count = activeFilters(query).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog's own trigger: Radix returns focus here when the sheet closes, however it was opened. */}
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="self-start lg:hidden"
          // The count is drawn as a badge; the name says it in words, in one phrase.
          aria-label={count > 0 ? t('directory:filters.openActive', { count }) : undefined}
          data-filter-trigger=""
        >
          <SlidersHorizontal aria-hidden="true" />
          {t('directory:filters.open')}
          {count > 0 && (
            <span
              aria-hidden="true"
              className="bg-foreground text-background flex h-5 min-w-5 items-center justify-center rounded-xs px-1.5 font-mono text-xs tabular-nums"
            >
              {count}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t('directory:filters.close')}
        aria-describedby={undefined}
        className="top-auto bottom-0 left-0 max-h-[90dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none border-x-0 border-b-0 sm:left-1/2 sm:max-w-xl sm:-translate-x-1/2"
      >
        <DialogHeader>
          <DialogTitle>{t('directory:filters.label')}</DialogTitle>
        </DialogHeader>
        <SheetForm
          query={query}
          lists={lists}
          errors={errors}
          onCommit={(next) => {
            onCommit(next)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The sheet's fields and its two actions, drafted from the URL when the sheet opens. */
function SheetForm({ query, lists, errors, onCommit }: CommitProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(() => draftOf(query))
  const [badPrices, setBadPrices] = useState<ReadonlySet<'min' | 'max'>>(new Set())

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const bad = badAmounts(draft)
    setBadPrices(bad)
    if (bad.size > 0) return
    if (draft.date !== '' && !isCalendarDate(draft.date)) return
    onCommit(withFilters(query, draft))
  }

  return (
    <form noValidate onSubmit={apply} className="flex min-h-0 flex-1 flex-col" data-filter-sheet="">
      <DialogBody>
        <FilterFields
          draft={draft}
          onChange={(key, value) => {
            setDraft((current) => ({ ...current, [key]: value }))
            if (key === 'min' || key === 'max') setBadPrices(new Set())
          }}
          errors={errors}
          query={query}
          badPrices={badPrices}
          lists={lists}
          layout="sheet"
        />
      </DialogBody>
      <div className="grid shrink-0 grid-cols-2 gap-3 border-t px-4 py-4 sm:px-6">
        <Button type="button" variant="outline" onClick={() => setDraft(draftOf({}))}>
          {t('directory:filters.clear')}
        </Button>
        <Button type="submit">{t('directory:filters.apply')}</Button>
      </div>
    </form>
  )
}

/** A chip's words, from the lists when they have the value, else the value as given. */
function chipLabel(filter: ActiveFilter, query: DirectoryQuery, lists: FilterLists | null, t: TFunction): string {
  const money = (value: string) => (isWholeAmount(value) ? formatMoney(Number(value)) : value)
  switch (filter) {
    case 'category':
      return lists?.categories.find((category) => category.slug === query.category)?.name ?? query.category ?? ''
    case 'district':
      return (
        lists?.provinces.flatMap((province) => province.districts).find((district) => district.code === query.district)?.name ??
        query.district ??
        ''
      )
    case 'price':
      if (query.min && query.max) return t('directory:filters.priceRange', { min: money(query.min), max: money(query.max) })
      if (query.min) return t('directory:filters.priceFrom', { min: money(query.min) })
      return t('directory:filters.priceTo', { max: money(query.max ?? '') })
    case 'date':
      return t('directory:filters.freeOn', { date: isCalendarDate(query.date) ? formatDate(query.date) : (query.date ?? '') })
  }
}

const REMOVES: Record<ActiveFilter, Partial<Record<FilterKey, null>>> = {
  category: { category: null },
  district: { district: null },
  price: { min: null, max: null },
  date: { date: null },
}

/**
 * One removable chip per active filter, then "Clear filters". A chip the API
 * refused has the danger edge. After a chip goes, focus moves to the chip
 * that took its place, else to `fallbackFocus`: never to the page body.
 */
export function FilterChips({
  query,
  lists,
  errors,
  onCommit,
  fallbackFocus,
}: CommitProps & { fallbackFocus: () => void }) {
  const { t } = useTranslation()
  const active = activeFilters(query)
  const list = useRef<HTMLUListElement>(null)
  const pendingFocus = useRef<number | null>(null)
  const refused = new Set(
    (Object.keys(errors) as (keyof FieldErrors)[]).map(chipOf).filter((chip): chip is ActiveFilter => chip !== null),
  )
  const key = active.join(',')

  useEffect(() => {
    const index = pendingFocus.current
    if (index === null) return
    pendingFocus.current = null
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button[data-chip]') ?? []
    const target = buttons[Math.min(index, buttons.length - 1)]
    if (target !== undefined) target.focus()
    else fallbackFocus()
  }, [key, fallbackFocus])

  if (active.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2" data-filter-chips="">
      <ul ref={list} aria-label={t('directory:filters.chips')} className="flex flex-wrap gap-2">
        {active.map((filter, index) => {
          const label = chipLabel(filter, query, lists, t)
          return (
            <li key={filter}>
              <button
                type="button"
                data-chip={filter}
                aria-label={t('directory:filters.remove', { label })}
                onClick={() => {
                  pendingFocus.current = index
                  onCommit(withFilters(query, REMOVES[filter]))
                }}
                className={cn(
                  'bg-background hover:border-muted-foreground inline-flex h-10 max-w-full items-center gap-2 rounded-xs border pr-2.5 pl-3 text-sm pointer-coarse:h-11 motion-safe:transition-[border-color] motion-safe:duration-150',
                  refused.has(filter) && 'border-destructive hover:border-destructive',
                )}
              >
                <span className="min-w-0 truncate">{label}</span>
                <X aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
              </button>
            </li>
          )
        })}
      </ul>
      <Button
        type="button"
        variant="link"
        // Its words line up with the chips when it wraps to its own row.
        className="client:px-1"
        onClick={() => {
          pendingFocus.current = 0
          onCommit({})
        }}
      >
        {t('directory:filters.clearAll')}
      </Button>
    </div>
  )
}
