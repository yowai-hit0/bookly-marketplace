import { Navigate, type RouteObject } from 'react-router'
import { AdminLayout } from '@/admin/AdminLayout'
import { RequireSession } from '@/auth/RequireSession'
import { PlatformLayout } from '@/platform/PlatformLayout'
import { ClientShell } from '@/pages/ClientShell'
import { Home } from '@/pages/Home'
import { LegacyAdminRedirect } from '@/pages/LegacyAdminRedirect'
import { NotFound } from '@/pages/NotFound'
import { AdminAvailability } from '@/pages/admin/AdminAvailability'
import { AdminBookingDetail } from '@/pages/admin/AdminBookingDetail'
import { AdminBookings } from '@/pages/admin/AdminBookings'
import { AdminCatalogue } from '@/pages/admin/AdminCatalogue'
import { AdminEarnings } from '@/pages/admin/AdminEarnings'
import { AdminPayoutDetail } from '@/pages/admin/AdminPayoutDetail'
import { AdminPayoutMethod } from '@/pages/admin/AdminPayoutMethod'
import { AdminPortfolio } from '@/pages/admin/AdminPortfolio'
import { AdminProfile } from '@/pages/admin/AdminProfile'
import { AdminSettings } from '@/pages/admin/AdminSettings'
import { AdminSetup } from '@/pages/admin/AdminSetup'
import { AdminSubscription } from '@/pages/admin/AdminSubscription'
import { AccountBookingPage, AccountPaymentProgressPage } from '@/pages/account/AccountBookingPage'
import { AccountDashboard } from '@/pages/account/AccountDashboard'
import { AccountDeletedPage } from '@/pages/account/AccountDeletedPage'
import { AccountEmailConfirmPage } from '@/pages/account/AccountEmailConfirmPage'
import { AccountLayout } from '@/pages/account/AccountLayout'
import { AccountPayments } from '@/pages/account/AccountPayments'
import { AccountProfile } from '@/pages/account/AccountProfile'
import { AccountReceipt } from '@/pages/account/AccountReceipt'
import { GoogleCallbackPage } from '@/pages/auth/GoogleCallbackPage'
import { LoginPage } from '@/pages/auth/LoginPage'
import { ResetPasswordPage } from '@/pages/auth/ResetPasswordPage'
import { SignupPage } from '@/pages/auth/SignupPage'
import { VerifyPage } from '@/pages/auth/VerifyPage'
import { BookingPage } from '@/pages/booking/BookingPage'
import { EmailConfirmPage } from '@/pages/booking/EmailConfirmPage'
import { MyBookingPage } from '@/pages/booking/MyBookingPage'
import { CheckoutPage } from '@/pages/checkout/CheckoutPage'
import { PaymentProgressPage } from '@/pages/checkout/PaymentProgressPage'
import { PhotographerList } from '@/pages/photographers/PhotographerList'
import { PhotographerProfile } from '@/pages/photographers/PhotographerProfile'
import { PlatformPayoutDetail } from '@/pages/platform/PlatformPayoutDetail'
import { PlatformPayouts } from '@/pages/platform/PlatformPayouts'
import { PlatformPhotographers } from '@/pages/platform/PlatformPhotographers'
import { PlatformRefunds } from '@/pages/platform/PlatformRefunds'
import { PlatformSettings } from '@/pages/platform/PlatformSettings'
import { PlatformSubscriptions } from '@/pages/platform/PlatformSubscriptions'
import { ServiceDetail } from '@/pages/services/ServiceDetail'

/**
 * Plain paths, no locale prefix (plan.md Task 2, spec §7, R-2). A French
 * launch adds routes; it does not restructure these.
 *
 * Three signed-in areas (marketplace spec, URL map): the photographer's
 * studio, the platform console and the client's account, each guarded by its
 * own session and with its own sign-in pages, which sit outside the guard.
 */
export const routes: RouteObject[] = [
  // A pathless layout route: every client page gets the header and footer, and
  // each keeps its own `main` (`pages/ClientShell.tsx`). `*` is inside it too --
  // someone who mistyped a URL is exactly who needs a way out.
  {
    element: <ClientShell />,
    children: [
      { path: '/', element: <Home /> },
      // The public marketplace (Phase 6, R6.3): the directory with its
      // URL-synced filters, one photographer's profile, then one service.
      { path: '/photographers', element: <PhotographerList /> },
      { path: '/p/:handle', element: <PhotographerProfile /> },
      { path: '/p/:handle/:slug', element: <ServiceDetail /> },
      // The single-photographer catalogue's old address. The list moved, so it
      // redirects; a service has no address without its photographer, so
      // `/services/:slug` falls through to `*` and is not found.
      { path: '/services', element: <Navigate to="/photographers" replace /> },
      // The booking fee (plan.md Task 16): pay, then follow the payment until it settles.
      { path: '/checkout/:reference/:token', element: <CheckoutPage /> },
      { path: '/checkout/:reference/:token/payments/:ourRef', element: <PaymentProgressPage /> },
      // The client's own booking, addressed by the token in the path (plan.md Task 18).
      // Lost the link: get a fresh one by email (2026-09-25).
      { path: '/my-booking', element: <MyBookingPage /> },
      // A contact-email change, confirmed from the new address (2026-09-25).
      { path: '/email-confirm/:token', element: <EmailConfirmPage /> },
      { path: '/booking/:token', element: <BookingPage /> },
      { path: '/booking/:token/payments/:ourRef', element: <PaymentProgressPage /> },
      // The client's account (Phase 2): its sign-in pages wear the client
      // shell. The dashboard (Phase 8, R8.1-R8.3) needs the account session:
      // the account nav, then the bookings, one booking and its session-fee
      // payment, the payments and a receipt, and the profile.
      {
        path: '/account',
        element: (
          <RequireSession area="account">
            <AccountLayout />
          </RequireSession>
        ),
        children: [
          { index: true, element: <AccountDashboard /> },
          { path: 'bookings/:reference', element: <AccountBookingPage /> },
          { path: 'bookings/:reference/payments/:ourRef', element: <AccountPaymentProgressPage /> },
          { path: 'payments', element: <AccountPayments /> },
          { path: 'payments/:ourRef/receipt', element: <AccountReceipt /> },
          { path: 'profile', element: <AccountProfile /> },
        ],
      },
      // No session needed: the address-change link opens in any tab, and the
      // deleted page follows the session's end.
      { path: '/account/email-confirm/:token', element: <AccountEmailConfirmPage /> },
      { path: '/account/deleted', element: <AccountDeletedPage /> },
      { path: '/account/login', element: <LoginPage area="account" /> },
      { path: '/account/signup', element: <SignupPage area="account" /> },
      { path: '/account/verify/:token', element: <VerifyPage area="account" /> },
      { path: '/account/reset-password', element: <ResetPasswordPage area="account" /> },
      { path: '/account/google/callback', element: <GoogleCallbackPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
  // The photographer's studio, `/admin` until Phase 2. Its signed-out pages
  // sit outside the layout's session guard. The emailed reset link carries its
  // token in the fragment (plan.md Task 7).
  { path: '/studio/login', element: <LoginPage area="studio" /> },
  { path: '/studio/signup', element: <SignupPage area="studio" /> },
  { path: '/studio/verify/:token', element: <VerifyPage area="studio" /> },
  { path: '/studio/reset-password', element: <ResetPasswordPage area="studio" /> },
  {
    path: '/studio',
    element: <AdminLayout />,
    children: [
      { index: true, element: <Navigate to="calendar" replace /> },
      // Lazy: FullCalendar and Luxon are the heaviest code in the app, and no
      // public visitor should download them (spec §7, initial payload).
      {
        path: 'calendar',
        lazy: async () => ({ Component: (await import('@/pages/admin/AdminCalendar')).AdminCalendar }),
      },
      { path: 'catalogue', element: <AdminCatalogue /> },
      // Bookings: the list and one booking's lifecycle (plan.md Task 19).
      { path: 'bookings', element: <AdminBookings /> },
      { path: 'bookings/:id', element: <AdminBookingDetail /> },
      // Working hours and blocks together (plan.md Task 8): one screen, because
      // between them they answer when a client can book.
      { path: 'availability', element: <AdminAvailability /> },
      // Money out (Phase 4, R4.1, R4.5): what he earned and was paid, one
      // payout, and where the platform sends it.
      { path: 'earnings', element: <AdminEarnings /> },
      { path: 'payouts/:id', element: <AdminPayoutDetail /> },
      { path: 'payout-method', element: <AdminPayoutMethod /> },
      // Paying for the subscription that keeps the profile bookable (Phase 5, R5.2).
      { path: 'subscription', element: <AdminSubscription /> },
      { path: 'settings', element: <AdminSettings /> },
      // Onboarding (Phase 7, R7.2, R7.3): the public profile, its portfolio,
      // and the checklist a pending studio submits for review.
      { path: 'profile', element: <AdminProfile /> },
      { path: 'portfolio', element: <AdminPortfolio /> },
      { path: 'setup', element: <AdminSetup /> },
    ],
  },
  // Old links, emailed ones included, still land.
  { path: '/admin', element: <LegacyAdminRedirect /> },
  { path: '/admin/*', element: <LegacyAdminRedirect /> },
  // The platform admin's console (Phase 2 brief decision 7, minimal).
  { path: '/platform/login', element: <LoginPage area="platform" /> },
  { path: '/platform/verify/:token', element: <VerifyPage area="platform" /> },
  { path: '/platform/reset-password', element: <ResetPasswordPage area="platform" /> },
  {
    path: '/platform',
    element: (
      <RequireSession area="platform">
        <PlatformLayout />
      </RequireSession>
    ),
    children: [
      { index: true, element: <Navigate to="photographers" replace /> },
      { path: 'photographers', element: <PlatformPhotographers /> },
      // Payouts by hand and refunds of money paid online (Phase 4, R4.4, R4.6).
      { path: 'payouts', element: <PlatformPayouts /> },
      { path: 'payouts/:id', element: <PlatformPayoutDetail /> },
      { path: 'refunds', element: <PlatformRefunds /> },
      // Every subscription, and the settings it and the checkout run on (Phase 5, R5.1, R5.4).
      { path: 'subscriptions', element: <PlatformSubscriptions /> },
      { path: 'settings', element: <PlatformSettings /> },
    ],
  },
]
