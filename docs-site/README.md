# Bookly documentation site

The [VitePress](https://vitepress.dev) site that publishes Bookly's
documentation. This release ships the **developer guide** and the **API
reference**; a photographer's guide and a client help centre, in English and
French, are planned follow-ups.

## Develop

```sh
npm install
npm run dev        # bundles the OpenAPI spec, then serves the site
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Render the reference from the local spec, then run the dev server. |
| `npm run build` | Render the reference, then build the static site to `.vitepress/dist/`. |
| `npm run preview` | Serve the built site. |
| `npm run sync-spec` | Regenerate the vendored `openapi.json` from `../backend/openapi` (run on API changes). |
| `npm run bundle-openapi` | Render `public/api-reference.html` + `public/openapi.json` from the local `openapi.json`. |
| `npm run api:lint` | Lint the vendored `openapi.json` with Redocly. |

## Deploy

The site is self-contained: it builds from its own files (`openapi.json` is
vendored), so **the `backend/` folder is not needed at deploy time** and the
docs can ship from `docs-site/` alone.

On Vercel, Netlify or Cloudflare Pages:

| Setting | Value |
|---|---|
| Root directory / base directory | `docs-site` |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `.vitepress/dist` |

Deploying under a sub-path (e.g. GitHub Pages project sites) needs `base` set in
`.vitepress/config.ts`. After the API changes, run `npm run sync-spec` and
commit the updated `openapi.json` so the next deploy picks it up.

## How the API reference works

The source of truth is the hand-written spec at
`../backend/openapi/openapi.yaml`, kept honest by a backend test
(`src/openapi.test.ts`). This site does **not** read it at build time — instead
it vendors a bundled copy, [`openapi.json`](openapi.json), so it can build and
deploy on its own without the `backend/` folder present.

- `npm run sync-spec` regenerates `openapi.json` from the backend source. It is
  the only script that reaches into `../backend`; run it whenever the API
  changes. The backend test fails if the committed copy falls behind, so the two
  cannot silently drift.
- `scripts/bundle-openapi.mjs` (run by `dev`/`build`) reads the local
  `openapi.json`, renders the standalone [Redoc](https://github.com/Redocly/redoc)
  page to `public/api-reference.html`, and copies the spec to
  `public/openapi.json` for download. `api/index.md` embeds the Redoc page in a
  full-width frame.

Everything under `public/` is generated and git-ignored; `openapi.json` at the
site root is the one committed, vendored file.

## Structure

- `index.md` — landing page.
- `developers/` — the developer guide (architecture, setup, data model, booking
  lifecycle, payments, outbox, auth, testing).
- `api/` — `index.md` (the reference) and `conventions.md`.
- `.vitepress/config.ts` — site config, navigation and sidebar.
- `.vitepress/theme/` — the default theme plus the `ApiReference` component.
- `scripts/` — the spec bundler.
