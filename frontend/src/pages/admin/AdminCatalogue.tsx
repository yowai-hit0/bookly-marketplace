import { Check, CircleAlert, Package, Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import {
  type AdminAddon,
  type AdminPackage,
  type CatalogueData,
  type CatalogueService,
  type DurationWarning,
  type PackageSaved,
  addonFormSchema,
  addonFormValues,
  catalogueApi,
  formatMinuteOfDay,
  packageFormSchema,
  packageFormValues,
  serviceFormSchema,
  serviceFormValues,
} from '@/admin/catalogue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EYEBROW, META, PAGE, SECTION_TITLE } from './console/classes'
import { LoadingRegion, PanelSkeleton } from './console/Skeletons'
import { PageHeader } from './console/PageHeader'
import { EntityForm, type FieldSpec } from './EntityForm'
import { FormDialog } from './console/FormDialog'

/**
 * The catalogue CMS (plan.md Task 10, spec §3.4, §6.8, §6.14): services, their
 * packages and add-ons, and the add-ons offered on every service.
 *
 * One form is open at a time. After any save the whole catalogue is fetched
 * again -- it is a few dozen rows -- so what is shown is always what is stored.
 * Reordering is the display-order field; deactivating is how something stops
 * being sold, and delete is refused by the API for anything in use.
 */

const SERVICE_FIELDS: readonly FieldSpec[] = [
  { name: 'nameEn', kind: 'text' },
  { name: 'slug', kind: 'text', hint: true },
  { name: 'descriptionEn', kind: 'textarea' },
  { name: 'coverImageUrl', kind: 'text', hint: true },
  { name: 'bookingFeePercent', kind: 'number', hint: true },
  { name: 'sortOrder', kind: 'number', hint: true },
  { name: 'isActive', kind: 'checkbox' },
]

const PACKAGE_FIELDS: readonly FieldSpec[] = [
  { name: 'nameEn', kind: 'text' },
  { name: 'priceRwf', kind: 'number', hint: true },
  { name: 'photoCount', kind: 'number' },
  { name: 'durationMinutes', kind: 'number' },
  { name: 'descriptionEn', kind: 'textarea' },
  { name: 'sortOrder', kind: 'number', hint: true },
  { name: 'isActive', kind: 'checkbox' },
]

const ADDON_FIELDS: readonly FieldSpec[] = [
  { name: 'nameEn', kind: 'text' },
  { name: 'priceRwf', kind: 'number', hint: true },
  { name: 'sortOrder', kind: 'number', hint: true },
  { name: 'isActive', kind: 'checkbox' },
]

/** Which form is open: `service:new`, `service:<id>`, `package:new:<serviceId>`, … */
type Editing = string | null

/** A number inside a meta line: the data face, at the line's own size. */
const FIGURE = 'font-mono tabular-nums'

/** One item of a meta line ("Order 0"): the line wraps between items, never inside one. */
const ITEM = 'whitespace-nowrap'

/** A list's heading in a service panel: a mono label over a hairline, like a table's header row. */
const LIST_HEADING = cn(EYEBROW, 'border-b pb-3')

/** A package or add-on row: hairlines between rows, none under the last. */
const LIST_ROW = 'flex flex-col gap-3 border-b py-4 last:border-b-0'

/** An error line: danger text led by its icon. */
const ERROR_LINE = 'flex items-start gap-2 text-sm text-destructive'

/**
 * A translated meta item with its number set in the data face ("Order 0",
 * "Booking fee 37.5%", "20 photos"). Only the face changes: the words are the
 * string's own and the text is exactly what `t` returned.
 */
function withFigure(phrase: string, value: number): ReactNode {
  const figure = String(value)
  const at = phrase.indexOf(figure)
  if (at < 0) return <span className={ITEM}>{phrase}</span>
  return (
    <span className={ITEM}>
      {phrase.slice(0, at)}
      <span className={FIGURE}>{figure}</span>
      {phrase.slice(at + figure.length)}
    </span>
  )
}

export function AdminCatalogue() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [version, setVersion] = useState(0)
  /** The latest load; `data` is null when it failed. Kept across reloads, so a
   *  save does not blank the page while the fresh copy arrives. */
  const [loaded, setLoaded] = useState<{ data: CatalogueData | null } | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<Record<string, DurationWarning>>({})

  useEffect(() => {
    let cancelled = false
    catalogueApi
      .load()
      .then((data) => !cancelled && setLoaded({ data }))
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          navigate('/admin/login', { replace: true })
          return
        }
        setLoaded({ data: null })
      })
    return () => {
      cancelled = true
    }
  }, [version, navigate])

  const reload = () => setVersion((n) => n + 1)

  /** A save from an open form: close it and refetch. Errors stay in the form. */
  async function saved(action: Promise<unknown>) {
    await action
    setEditing(null)
    reload()
  }

  function rememberWarning({ package: pkg, warning }: PackageSaved) {
    setWarnings((current) => {
      const next = { ...current }
      if (warning === null) delete next[pkg.id]
      else next[pkg.id] = warning
      return next
    })
  }

  /** A one-click action (activate, deactivate, delete). */
  async function act(action: () => Promise<unknown>) {
    setActionError(null)
    try {
      await action()
      reload()
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        navigate('/admin/login', { replace: true })
        return
      }
      const inUse = error instanceof ApiError && error.message === 'in_use'
      setActionError(t(inUse ? 'admin:catalogue.inUse' : 'admin:catalogue.actionFailed'))
    }
  }

  function remove(name: string, action: () => Promise<unknown>) {
    if (window.confirm(t('admin:catalogue.confirmDelete', { name }))) void act(action)
  }

  function rowActions(name: string, isActive: boolean, key: string, toggle: () => Promise<unknown>, del: () => Promise<unknown>) {
    // Quiet: three buttons on every row. Below `sm` they wrap under the row's
    // text, each 44px tall; beside it from `sm`.
    return (
      <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
        <Button
          size="console-sm"
          variant="console-outline"
          aria-label={t('admin:catalogue.editNamed', { name })}
          onClick={() => setEditing(key)}
        >
          {t('admin:catalogue.edit')}
        </Button>
        <Button
          size="console-sm"
          variant="console-outline"
          aria-label={t(isActive ? 'admin:catalogue.deactivateNamed' : 'admin:catalogue.activateNamed', { name })}
          onClick={() => void act(toggle)}
        >
          {t(isActive ? 'admin:catalogue.deactivate' : 'admin:catalogue.activate')}
        </Button>
        <Button
          size="console-sm"
          variant="destructive"
          aria-label={t('admin:catalogue.deleteNamed', { name })}
          onClick={() => remove(name, del)}
        >
          {t('admin:catalogue.delete')}
        </Button>
      </div>
    )
  }

  /** Active is the success pair with a check; inactive the neutral chip. The word is always there. */
  function statusBadge(isActive: boolean) {
    return isActive ? (
      <Badge variant="console-success">
        <Check aria-hidden="true" />
        {t('admin:catalogue.active')}
      </Badge>
    ) : (
      <Badge variant="console">{t('admin:catalogue.inactive')}</Badge>
    )
  }

  /** A row's name and badge over its meta line; the actions beside or below. */
  function rowLayout(name: string, isActive: boolean, meta: ReactNode, actions: ReactNode) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="min-w-0 font-medium wrap-anywhere">{name}</span>
            {statusBadge(isActive)}
          </div>
          <p className={cn(META, 'wrap-anywhere')}>{meta}</p>
        </div>
        {actions}
      </div>
    )
  }

  /**
   * Every create and edit form opens in a dialog (2026-09-27). One form is open
   * at a time, as before; closing the dialog by any route discards the form.
   */
  function formDialog(open: boolean, title: string, form: ReactNode) {
    return (
      <FormDialog open={open} onClose={() => setEditing(null)} title={title} wide>
        {form}
      </FormDialog>
    )
  }

  function packageRow(pkg: AdminPackage) {
    const key = `package:${pkg.id}`
    const warning = warnings[pkg.id]
    return (
      <li key={pkg.id} className={LIST_ROW}>
        {rowLayout(
          pkg.nameEn,
          pkg.isActive,
          <>
            <span className={cn(ITEM, FIGURE, 'text-foreground')}>{formatMoney(pkg.priceRwf)}</span> ·{' '}
            {withFigure(t('admin:catalogue.photos', { count: pkg.photoCount }), pkg.photoCount)} ·{' '}
            <span className={cn(ITEM, FIGURE)}>{t('admin:catalogue.duration', { minutes: pkg.durationMinutes })}</span> ·{' '}
            {withFigure(t('admin:catalogue.order', { order: pkg.sortOrder }), pkg.sortOrder)}
          </>,
          rowActions(
            pkg.nameEn,
            pkg.isActive,
            key,
            () => catalogueApi.updatePackage(pkg.id, { isActive: !pkg.isActive }).then(rememberWarning),
            () => catalogueApi.deletePackage(pkg.id),
          ),
        )}
        {warning !== undefined && (
          <p className={ERROR_LINE} role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
              {warning.longestWindow === null
                ? t('admin:catalogue.durationWarningNoHours', { name: pkg.nameEn })
                : t('admin:catalogue.durationWarning', {
                    name: pkg.nameEn,
                    minutes: pkg.durationMinutes,
                    opens: formatMinuteOfDay(warning.longestWindow.opensMinute),
                    closes: formatMinuteOfDay(warning.longestWindow.closesMinute),
                    longest: warning.longestWindow.closesMinute - warning.longestWindow.opensMinute,
                  })}
            </span>
          </p>
        )}
        {formDialog(
          editing === key,
          t('admin:catalogue.editPackage'),
          <EntityForm
            title={t('admin:catalogue.editPackage')}
            submitLabel={t('admin:catalogue.save')}
            fields={PACKAGE_FIELDS}
            values={packageFormValues(pkg)}
            schema={packageFormSchema}
            onSave={(payload) => saved(catalogueApi.updatePackage(pkg.id, payload).then(rememberWarning))}
            onCancel={() => setEditing(null)}
          />,
        )}
      </li>
    )
  }

  function addonRow(addon: AdminAddon) {
    const key = `addon:${addon.id}`
    return (
      <li key={addon.id} className={LIST_ROW}>
        {rowLayout(
          addon.nameEn,
          addon.isActive,
          <>
            <span className={cn(ITEM, FIGURE, 'text-foreground')}>{formatMoney(addon.priceRwf)}</span> ·{' '}
            {withFigure(t('admin:catalogue.order', { order: addon.sortOrder }), addon.sortOrder)}
          </>,
          rowActions(
            addon.nameEn,
            addon.isActive,
            key,
            () => catalogueApi.updateAddon(addon.id, { isActive: !addon.isActive }),
            () => catalogueApi.deleteAddon(addon.id),
          ),
        )}
        {formDialog(
          editing === key,
          t('admin:catalogue.editAddon'),
          <EntityForm
            title={t('admin:catalogue.editAddon')}
            submitLabel={t('admin:catalogue.save')}
            fields={ADDON_FIELDS}
            values={addonFormValues(addon)}
            schema={addonFormSchema}
            onSave={(payload) => saved(catalogueApi.updateAddon(addon.id, payload))}
            onCancel={() => setEditing(null)}
          />,
        )}
      </li>
    )
  }

  /**
   * The add-on list plus its "Add add-on" control, for one service or for all.
   * In a service panel its heading is a list label; the shared add-ons have a
   * panel of their own, where it is that panel's title.
   */
  function addonSection(serviceId: string | null, addons: AdminAddon[], heading: string) {
    const newKey = `addon:new:${serviceId ?? 'shared'}`
    return (
      <section className="flex flex-col">
        <h3 className={serviceId === null ? cn(SECTION_TITLE, 'border-b pb-4') : LIST_HEADING}>{heading}</h3>
        {addons.length === 0 ? (
          <p className={cn(META, 'py-4')}>{t('admin:catalogue.noAddons')}</p>
        ) : (
          <ul>{addons.map(addonRow)}</ul>
        )}
        <Button size="console-sm" variant="console-outline" className="mt-2 self-start" onClick={() => setEditing(newKey)}>
          <Plus aria-hidden="true" />
          {t('admin:catalogue.addAddon')}
        </Button>
        {formDialog(
          editing === newKey,
          t('admin:catalogue.newAddon'),
          <EntityForm
            title={t('admin:catalogue.newAddon')}
            submitLabel={t('admin:catalogue.create')}
            fields={ADDON_FIELDS}
            values={addonFormValues()}
            schema={addonFormSchema}
            onSave={(payload) => saved(catalogueApi.createAddon({ ...payload, serviceId }))}
            onCancel={() => setEditing(null)}
          />,
        )}
      </section>
    )
  }

  function serviceCard(service: CatalogueService) {
    const key = `service:${service.id}`
    const newPackageKey = `package:new:${service.id}`
    const feePercent = service.bookingFeeRateOverride === null ? null : Number((service.bookingFeeRateOverride * 100).toFixed(1))

    return (
      <Card key={service.id} variant="console">
        {/* The title row is split from the lists by a full-width hairline. */}
        <CardHeader className="border-b">
          {formDialog(
            editing === key,
            t('admin:catalogue.editService'),
            <EntityForm
              title={t('admin:catalogue.editService')}
              submitLabel={t('admin:catalogue.save')}
              fields={SERVICE_FIELDS}
              values={serviceFormValues(service)}
              schema={serviceFormSchema}
              onSave={(payload) => saved(catalogueApi.updateService(service.id, payload))}
              onCancel={() => setEditing(null)}
            />,
          )}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-col gap-1.5">
              {/* The badge is part of the heading's name ("Portraits Active"); it wraps under a long name. */}
              <h2 className={cn(SECTION_TITLE, 'flex flex-wrap items-center gap-x-3 gap-y-1.5')}>
                <span className="min-w-0 wrap-anywhere">{service.nameEn}</span> {statusBadge(service.isActive)}
              </h2>
              <p className={cn(META, 'wrap-anywhere')}>
                <span className={FIGURE}>/{service.slug}</span> ·{' '}
                {feePercent === null
                  ? <span className={ITEM}>{t('admin:catalogue.feeDefault')}</span>
                  : withFigure(t('admin:catalogue.feeOverride', { percent: feePercent }), feePercent)}{' '}
                · {withFigure(t('admin:catalogue.order', { order: service.sortOrder }), service.sortOrder)}
              </p>
            </div>
            {rowActions(
              service.nameEn,
              service.isActive,
              key,
              () => catalogueApi.updateService(service.id, { isActive: !service.isActive }),
              () => catalogueApi.deleteService(service.id),
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <section className="flex flex-col">
            <h3 className={LIST_HEADING}>{t('admin:catalogue.packages')}</h3>
            {service.packages.length === 0 ? (
              <p className={cn(META, 'py-4')}>{t('admin:catalogue.noPackages')}</p>
            ) : (
              <ul>{service.packages.map(packageRow)}</ul>
            )}
            <Button size="console-sm" variant="console-outline" className="mt-2 self-start" onClick={() => setEditing(newPackageKey)}>
              <Plus aria-hidden="true" />
              {t('admin:catalogue.addPackage')}
            </Button>
            {formDialog(
              editing === newPackageKey,
              t('admin:catalogue.newPackage'),
              <EntityForm
                title={t('admin:catalogue.newPackage')}
                submitLabel={t('admin:catalogue.create')}
                fields={PACKAGE_FIELDS}
                values={packageFormValues()}
                schema={packageFormSchema}
                onSave={(payload) =>
                  saved(catalogueApi.createPackage({ ...payload, serviceId: service.id }).then(rememberWarning))
                }
                onCancel={() => setEditing(null)}
              />,
            )}
          </section>
          {addonSection(service.id, service.addons, t('admin:catalogue.addons'))}
        </CardContent>
      </Card>
    )
  }

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      <PageHeader
        eyebrow={t('admin:nav.label')}
        eyebrowIcon={Package}
        title={t('admin:catalogue.title')}
        actions={
          // The page's one main action. It stays mounted while its dialog is
          // open, so focus returns to it when the dialog closes.
          <Button size="console" onClick={() => setEditing('service:new')}>
            <Plus aria-hidden="true" />
            {t('admin:catalogue.addService')}
          </Button>
        }
      >
        <p className={cn(META, 'max-w-prose')}>{t('admin:catalogue.intro')}</p>
      </PageHeader>

      {actionError !== null && (
        <p className={ERROR_LINE} role="alert">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {actionError}
        </p>
      )}

      {formDialog(
        editing === 'service:new',
        t('admin:catalogue.newService'),
        <EntityForm
          title={t('admin:catalogue.newService')}
          submitLabel={t('admin:catalogue.create')}
          fields={SERVICE_FIELDS}
          values={serviceFormValues()}
          schema={serviceFormSchema}
          onSave={(payload) => saved(catalogueApi.createService(payload))}
          onCancel={() => setEditing(null)}
        />,
      )}

      {loaded === null && (
        <LoadingRegion label={t('admin:catalogue.loading')} className="flex flex-col gap-4 lg:gap-6">
          <PanelSkeleton rows={3} />
          <PanelSkeleton rows={2} />
        </LoadingRegion>
      )}
      {loaded !== null && loaded.data === null && (
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4" role="alert">
          <p className={ERROR_LINE}>
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:catalogue.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={reload}>
            {t('admin:catalogue.retry')}
          </Button>
        </div>
      )}
      {loaded?.data != null && (
        // Panels in a list sit closer than the page's sections.
        <div className="flex flex-col gap-4 lg:gap-6">
          {loaded.data.services.length === 0 && <p className={META}>{t('admin:catalogue.empty')}</p>}
          {loaded.data.services.map(serviceCard)}
          <Card variant="console">
            <CardContent className="flex flex-col gap-1.5">
              <p className={META}>{t('admin:catalogue.sharedAddonsHint')}</p>
              {addonSection(null, loaded.data.sharedAddons, t('admin:catalogue.sharedAddons'))}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  )
}
