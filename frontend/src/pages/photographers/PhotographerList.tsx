import type { TFunction } from 'i18next'
import { ArrowLeft, ArrowRight, CircleAlert, Info, MapPin } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import {
  type DirectoryPage,
  type DirectoryQuery,
  directorySearch,
  fetchCategories,
  fetchDistricts,
  searchDirectory,
} from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { useDocumentMeta } from '@/lib/document-meta'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { container, eyebrow, lead, pageTitle, pageY } from '@/pages/client/classes'
import { type FilterLists, FilterBar, FilterChips, FilterSheet } from './DirectoryFilters'
import { PhotographerCard, PhotographerGridSkeleton } from './PhotographerCard'
import {
  type FieldErrors,
  activeFilters,
  fieldErrorKeys,
  isCalendarDate,
  onPage,
  pageNumber,
  readQuery,
  withFilters,
  writeQuery,
} from './directory-query'

/**
 * The directory (`design-system/bookly/pages/directory.md`; marketplace spec
 * R6.1, R6.3): every photographer the API lists, 24 a page, filtered by
 * category, district, price range and a date they are free.
 *
 * The URL is the state, so a filtered page can be shared and Back undoes a
 * change: each filter change is a new history entry, and the page asks the
 * API for exactly what the URL says (known keys, no empty value). A `422`
 * names the filters it refused, and each gets its sentence by its field; a
 * `400` means the link itself cannot be read. Past-due photographers are
 * listed last by the API with a "Not taking bookings" badge, and left out
 * once a date is chosen.
 */

type Loaded = { search: string } & (
  | { status: 'ok'; page: DirectoryPage }
  | { status: 'invalid'; fields: string[] }
  | { status: 'badRequest' }
  | { status: 'failed' }
)

/** Placeholder cards while a page loads: two rows at the widest breakpoint. */
const SKELETON_COUNT = 6

export function PhotographerList() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => readQuery(params), [params])
  const search = directorySearch(query)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [lists, setLists] = useState<FilterLists | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  /** Set when a pagination link is followed: the new page's results take focus. */
  const focusResults = useRef(false)

  // The filter lists, once. A failure leaves each select with its "any" option.
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchCategories(controller.signal), fetchDistricts(controller.signal)])
      .then(([categories, provinces]) => !controller.signal.aborted && setLists({ categories, provinces }))
      .catch(() => !controller.signal.aborted && setLists({ categories: [], provinces: [] }))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    searchDirectory(query, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setLoaded(result.status === 'ok' ? { search, status: 'ok', page: result.page } : result.status === 'invalid' ? { search, status: 'invalid', fields: result.fields } : { search, status: 'badRequest' })
      })
      .catch(() => !controller.signal.aborted && setLoaded({ search, status: 'failed' }))
    return () => controller.abort()
  }, [query, search, attempt])

  // A load for another query is stale: show loading, not the last results.
  const current = loaded?.search === search ? loaded : null

  const focusResultsHeading = useCallback(() => {
    const heading = resultsHeading.current
    if (heading === null) return
    heading.scrollIntoView?.({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (current === null || !focusResults.current) return
    focusResults.current = false
    focusResultsHeading()
  }, [current, focusResultsHeading])

  const commit = useCallback((next: DirectoryQuery) => setParams(writeQuery(next)), [setParams])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  const errors: FieldErrors = current?.status === 'invalid' ? fieldErrorKeys(current.fields, query) : {}
  const page = pageNumber(query)

  useDocumentMeta(directoryMeta(t, query, lists))

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <header className="flex flex-col gap-3">
        {/* Not the heading's own word again: where they are. */}
        <p className={eyebrow}>
          <MapPin aria-hidden="true" />
          {t('landing:market.eyebrow')}
        </p>
        <h1 className={pageTitle}>{t('photographers:title')}</h1>
        <p className={cn(lead, 'max-w-2xl')}>{t('directory:intro')}</p>
      </header>

      <div className="flex flex-col gap-4">
        <FilterBar query={query} lists={lists} errors={errors} onCommit={commit} />
        <FilterSheet query={query} lists={lists} errors={errors} onCommit={commit} open={sheetOpen} onOpenChange={setSheetOpen} />
        <FilterChips query={query} lists={lists} errors={errors} onCommit={commit} fallbackFocus={focusResultsHeading} />
      </div>

      <section aria-labelledby="directory-results" className="flex scroll-mt-6 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 id="directory-results" ref={resultsHeading} tabIndex={-1} className="sr-only">
            {t('directory:results')}
          </h2>
          {/* The count, in words, announced when it changes; the cards are not.
              With nothing found the callout below says so on screen, so the
              count is for screen readers only. */}
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'text-subtle-foreground text-[0.9375rem]',
              current?.status === 'ok' && current.page.photographers.length === 0 && 'sr-only',
            )}
          >
            {current === null ? t('photographers:loading') : current.status === 'ok' ? countLine(t, current.page, query) : ''}
          </p>
        </div>

        {current === null && (
          <div aria-busy="true">
            <PhotographerGridSkeleton count={SKELETON_COUNT} />
          </div>
        )}

        {current?.status === 'failed' && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              <Button variant="outline" size="sm" onClick={retry}>
                {t('photographers:retry')}
              </Button>
            }
          >
            <p>{t('photographers:loadFailed')}</p>
          </Callout>
        )}

        {current?.status === 'badRequest' && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              <Button variant="outline" size="sm" onClick={() => commit({})}>
                {t('directory:filters.clearAll')}
              </Button>
            }
          >
            <p>{t('directory:invalid.badLink')}</p>
          </Callout>
        )}

        {current?.status === 'invalid' && (
          <InvalidFilters query={query} errors={errors} onClear={() => commit({})} onEdit={() => setSheetOpen(true)} />
        )}

        {current?.status === 'ok' &&
          (current.page.photographers.length === 0 ? (
            <EmptyResults query={query} page={page} onCommit={commit} />
          ) : (
            <>
              <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {current.page.photographers.map((photographer, index) => (
                  <li key={photographer.handle}>
                    <PhotographerCard photographer={photographer} priority={index === 0} />
                  </li>
                ))}
              </ul>
              <Pagination
                query={query}
                result={current.page}
                onFollow={() => {
                  focusResults.current = true
                }}
              />
            </>
          ))}
      </section>
    </main>
  )
}

/** "12 photographers", or under a date (no total) "Showing 24 … free on …" / "Showing 25–48, free on …". */
function countLine(t: TFunction, result: DirectoryPage, query: DirectoryQuery): string {
  const count = result.photographers.length
  if (result.total !== undefined) return t('directory:count.total', { count: result.total })
  // Nothing under a date: "0 photographers", not "Showing 0 … free on …".
  if (count === 0) return t('directory:count.total', { count: 0 })
  const date = isCalendarDate(query.date) ? formatDate(query.date) : (query.date ?? '')
  if (result.page === 1 && !result.hasMore) return t('directory:count.showing', { count, date })
  const from = (result.page - 1) * result.pageSize + 1
  return t('directory:count.range', { from, to: from + count - 1, date })
}

/** The page's title follows its filters once their names are known (R6.6). */
function directoryMeta(t: TFunction, query: DirectoryQuery, lists: FilterLists | null) {
  const category = lists?.categories.find((entry) => entry.slug === query.category)?.name
  const district = lists?.provinces.flatMap((province) => province.districts).find((entry) => entry.code === query.district)?.name
  const title =
    category !== undefined && district !== undefined
      ? t('meta:directory.both', { category, district })
      : category !== undefined
        ? t('meta:directory.category', { category })
        : district !== undefined
          ? t('meta:directory.district', { district })
          : t('meta:directory.title')
  return { title: t('meta:titleSuffix', { title }), description: t('meta:directory.description') }
}

/**
 * The 422: the fields carry their own sentences from `lg`; below it they are
 * in the closed sheet, so the callout repeats each one and opens the sheet.
 */
function InvalidFilters({
  query,
  errors,
  onClear,
  onEdit,
}: {
  query: DirectoryQuery
  errors: FieldErrors
  onClear: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const pageOnly = Object.keys(errors).length === 1 && errors.page !== undefined
  if (pageOnly) {
    return (
      <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
        <p>{t('directory:invalid.page')}</p>
        <p>
          <Link to={{ search: writeQuery(onPage(query, 1)).toString() }} className="text-console-link hover:text-console-link-hover underline underline-offset-4">
            {t('directory:empty.firstPage')}
          </Link>
        </p>
      </Callout>
    )
  }
  const sentences = (['category', 'district', 'price', 'min', 'max', 'date', 'page'] as const)
    .map((field) => errors[field])
    .filter((key): key is string => key !== undefined)
  return (
    <Callout
      variant="console"
      tone="destructive"
      icon={CircleAlert}
      role="alert"
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="lg:hidden" onClick={onEdit}>
            {t('directory:invalid.editFilters')}
          </Button>
          <Button variant="outline" size="sm" onClick={onClear}>
            {t('directory:filters.clearAll')}
          </Button>
        </div>
      }
    >
      <p>{t('directory:invalid.summary')}</p>
      <ul className="list-disc pl-5 lg:hidden">
        {[...new Set(sentences)].map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </Callout>
  )
}

/** Nothing on this page: say why, and offer the change most likely to help. */
function EmptyResults({ query, page, onCommit }: { query: DirectoryQuery; page: number; onCommit: (next: DirectoryQuery) => void }) {
  const { t } = useTranslation()
  if (page > 1) {
    return (
      <Callout variant="console" tone="info" icon={Info}>
        <p>{t('directory:empty.pastEnd')}</p>
        <p>
          <Link
            to={{ search: writeQuery(onPage(query, 1)).toString() }}
            className="text-console-link hover:text-console-link-hover underline underline-offset-4"
          >
            {t('directory:empty.firstPage')}
          </Link>
        </p>
      </Callout>
    )
  }
  const active = activeFilters(query)
  if (active.length === 0) {
    return (
      <Callout variant="console" tone="info" icon={Info}>
        <p>{t('photographers:empty')}</p>
      </Callout>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <Callout variant="console" tone="info" icon={Info}>
        <p>{t('directory:empty.filtered')}</p>
      </Callout>
      <div className="flex flex-wrap gap-2">
        {query.date !== undefined && (
          <Button variant="outline" onClick={() => onCommit(withFilters(query, { date: null }))}>
            {t('directory:empty.removeDate')}
          </Button>
        )}
        {(query.min !== undefined || query.max !== undefined) && (
          <Button variant="outline" onClick={() => onCommit(withFilters(query, { min: null, max: null }))}>
            {t('directory:empty.removePrice')}
          </Button>
        )}
        <Button variant="outline" onClick={() => onCommit({})}>
          {t('directory:filters.clearAll')}
        </Button>
      </div>
    </div>
  )
}

/** Previous / Page N (of M) / Next, as links: shareable, and Back returns to the page before. */
function Pagination({ query, result, onFollow }: { query: DirectoryQuery; result: DirectoryPage; onFollow: () => void }) {
  const { t } = useTranslation()
  const page = result.page
  const pages = result.total === undefined ? null : Math.max(1, Math.ceil(result.total / result.pageSize))
  if (page === 1 && !result.hasMore) return null
  const href = (target: number) => {
    const search = writeQuery(onPage(query, target)).toString()
    return { search: search === '' ? '' : `?${search}` }
  }

  return (
    <nav aria-label={t('directory:pages.label')} className="flex items-center justify-between gap-3 border-t pt-6">
      {page > 1 ? (
        <Button asChild variant="outline">
          <Link to={href(page - 1)} rel="prev" onClick={onFollow}>
            <ArrowLeft aria-hidden="true" />
            {t('directory:pages.previous')}
          </Link>
        </Button>
      ) : (
        <span />
      )}
      <p className="text-subtle-foreground font-mono text-sm tabular-nums">
        {pages === null ? t('directory:pages.current', { page }) : t('directory:pages.currentOf', { page, pages })}
      </p>
      {result.hasMore ? (
        <Button asChild variant="outline">
          <Link to={href(page + 1)} rel="next" onClick={onFollow}>
            {t('directory:pages.next')}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  )
}
