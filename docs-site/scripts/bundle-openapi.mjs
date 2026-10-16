// Builds the API reference assets under public/, from the vendored spec
// `docs-site/openapi.json`. Runs before dev and build. Reads only local files,
// so the site builds and deploys without the backend/ folder present.
//
// The vendored spec is kept in step with the backend source by `npm run
// sync-spec` (the only script that touches ../backend) and by a backend test
// that fails if the two drift. Two outputs:
//   - api-reference.html: the standalone Redoc page the site embeds
//   - openapi.json: the bundled spec, offered as a raw download
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const specPath = join(root, 'openapi.json')
const outDir = join(root, 'public')

if (!existsSync(specPath)) {
  console.error(
    `Missing ${specPath}.\nGenerate it from the backend source with:\n  npm run sync-spec`,
  )
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

// The rendered reference. The standard Redoc theme is the look we want; we only
// hide the redundant "download" button (the spec is linked separately) and
// expand the success responses. Flag values are kept free of spaces so they
// survive the shell on every platform.
execFileSync(
  'npx',
  [
    'redocly',
    'build-docs',
    specPath,
    '--output', join(outDir, 'api-reference.html'),
    '--theme.openapi.hideDownloadButton=true',
    '--theme.openapi.expandResponses=200,201',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)

// The raw spec, for callers who want to import it.
copyFileSync(specPath, join(outDir, 'openapi.json'))

console.log('api-reference.html and openapi.json written to', outDir)
