import { Navigate, type RouteObject } from 'react-router'
import { AdminLayout } from '@/admin/AdminLayout'
import { ClientShell } from '@/pages/ClientShell'
import { Home } from '@/pages/Home'
import { NotFound } from '@/pages/NotFound'
import { AdminAvailability } from '@/pages/admin/AdminAvailability'
import { AdminBookingDetail } from '@/pages/admin/AdminBookingDetail'
import { AdminBookings } from '@/pages/admin/AdminBookings'
import { AdminCatalogue } from '@/pages/admin/AdminCatalogue'
import { AdminLogin } from '@/pages/admin/AdminLogin'
import { AdminResetPassword } from '@/pages/admin/AdminResetPassword'
import { AdminSettings } from '@/pages/admin/AdminSettings'
import { BookingPage } from '@/pages/booking/BookingPage'
import { EmailConfirmPage } from '@/pages/booking/EmailConfirmPage'
import { MyBookingPage } from '@/pages/booking/MyBookingPage'
import { CheckoutPage } from '@/pages/checkout/CheckoutPage'
import { PaymentProgressPage } from '@/pages/checkout/PaymentProgressPage'
import { ServiceDetail } from '@/pages/services/ServiceDetail'
import { ServiceList } from '@/pages/services/ServiceList'

/**
 * Plain paths, no locale prefix (plan.md Task 2, spec §7, R-2). A French
 * launch adds routes; it does not restructure these.
 */
export const routes: RouteObject[] = [
  // A pathless layout route: every client page gets the header and footer, and
  // each keeps its own `main` (`pages/ClientShell.tsx`). `*` is inside it too --
  // someone who mistyped a URL is exactly who needs a way out.
  {
    element: <ClientShell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/services', element: <ServiceList /> },
      { path: '/services/:slug', element: <ServiceDetail /> },
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
      { path: '*', element: <NotFound /> },
    ],
  },
  { path: '/admin/login', element: <AdminLogin /> },
  // Signed out by definition, so it sits outside the layout's session guard.
  // The emailed link carries its token in the fragment (plan.md Task 7).
  { path: '/admin/reset-password', element: <AdminResetPassword /> },
  {
    path: '/admin',
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
      { path: 'settings', element: <AdminSettings /> },
    ],
  },
]
