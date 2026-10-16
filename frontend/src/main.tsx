import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router'
import './index.css'
import '@/i18n'
import { installErrorReporter } from '@/lib/report-error'
import { routes } from '@/routes'

// Errors are logged with every access token scrubbed out of them (plan.md Task 18).
installErrorReporter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(routes)} />
  </StrictMode>,
)
