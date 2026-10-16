import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

// Safety net: the Redoc page and the raw spec are generated into public/ by
// `npm run bundle-openapi` (which `npm run dev`/`build` run first). If a host's
// build command is just `vitepress build` and skips that step, those files are
// absent and the /api page 404s. Config is imported before the build copies
// public/, so regenerate them here when they're missing — a no-op in the normal
// flow, where bundle-openapi already produced them.
const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(siteRoot, 'public', 'api-reference.html'))) {
  execFileSync('node', [join(siteRoot, 'scripts', 'bundle-openapi.mjs')], { stdio: 'inherit', cwd: siteRoot })
}

// The documentation site: client help, a photographer guide (payments and
// security so far), the developer guide and the API reference. French versions
// and the rest of the user guides are a planned follow-up.
export default defineConfig({
  title: 'Bookly',
  description: 'Documentation for the Bookly booking platform.',
  cleanUrls: true,
  lastUpdated: true,
  // The generated spec lives in public/ but is not a page.
  srcExclude: ['**/GLOSSARY.md', '**/README.md'],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Clients', link: '/help/' },
      { text: 'Photographer', link: '/guide/' },
      { text: 'Developers', link: '/developers/' },
      {
        text: 'API',
        items: [
          { text: 'Reference', link: '/api/' },
          { text: 'Conventions', link: '/api/conventions' },
        ],
      },
    ],
    sidebar: {
      '/help/': [
        {
          text: 'Help for clients',
          items: [
            { text: 'Overview', link: '/help/' },
            { text: 'Paying for your booking', link: '/help/paying' },
            { text: 'Privacy and payment safety', link: '/help/privacy-and-safety' },
          ],
        },
      ],
      '/guide/': [
        {
          text: 'Photographer guide',
          items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Payments, cash and refunds', link: '/guide/payments' },
            { text: 'Security and responsibilities', link: '/guide/security' },
          ],
        },
      ],
      '/developers/': [
        {
          text: 'Developer guide',
          items: [
            { text: 'Overview', link: '/developers/' },
            { text: 'Architecture', link: '/developers/architecture' },
            { text: 'Local setup', link: '/developers/local-setup' },
            { text: 'Data model', link: '/developers/data-model' },
            { text: 'Booking lifecycle', link: '/developers/booking-lifecycle' },
            { text: 'Payments', link: '/developers/payments' },
            { text: 'Email and the outbox', link: '/developers/email-and-outbox' },
            { text: 'Auth and security', link: '/developers/auth-and-security' },
            { text: 'Testing', link: '/developers/testing' },
          ],
        },
        {
          text: 'API',
          items: [
            { text: 'Reference', link: '/api/' },
            { text: 'Conventions', link: '/api/conventions' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API',
          items: [
            { text: 'Reference', link: '/api/' },
            { text: 'Conventions', link: '/api/conventions' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    outline: 'deep',
  },
})
