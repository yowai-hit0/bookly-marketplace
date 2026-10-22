# Bookly frontend

The React + Vite single-page app for Bookly: the public booking flow, the
client's own booking page (reached by an emailed link), and the photographer's
admin panel. It talks to the [backend](../backend/) over `/api/*`. See the
repository [README](../README.md) for the big picture.

## Setup

Node 22+. Run the [backend](../backend/) first, or API calls will fail.

```sh
npm install
npm run dev        # Vite on http://localhost:5173, proxying /api to the backend
```

`VITE_API_BASE_URL` sets where `/api` calls go. In development Vite proxies
`/api` to `http://localhost:4000`, so the browser makes same-origin requests; in
production it is the backend's deployed origin. It is the only `VITE_*` variable
and is safe to ship in the bundle — no secret belongs in frontend configuration.

## Sitemap and robots.txt (marketplace spec R6.6)

The sitemap is built by the API at its **root**, `GET <API_ORIGIN>/sitemap.xml`
(not under `/api`). The web host serves it as its own `/sitemap.xml` through a
rewrite in `vercel.json`, listed **before** the SPA catch-all, and
`public/robots.txt` names `<WEB_ORIGIN>/sitemap.xml`.

Both files hold **placeholders** that must be replaced before launch:

| File | Placeholder | Replace with |
|---|---|---|
| `vercel.json` (the `/sitemap.xml` rewrite) | `https://api.bookly.example` | the backend's deployed origin (the `VITE_API_BASE_URL` origin) |
| `public/robots.txt` (`Sitemap:` line) | `https://bookly.example` | the web app's origin, the backend's `WEB_ORIGIN` |

Per-route `<title>`, description and Open Graph tags are set by
`src/lib/document-meta.ts`; `index.html` carries the defaults.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Type-check the project references and build to `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | `tsc -b --noEmit`. |
| `npm run lint` | Oxlint. |
| `npm test` | Vitest (component and unit tests). |
| `npm run test:e2e` | Playwright end-to-end specs. |

## Layout

- `src/pages/` — routes: the public site, `client/` and `booking/` (the token
  page), `checkout/`, and `admin/`. `src/routes.tsx` wires them up.
- `src/admin/` — the admin shell, session handling (token in `sessionStorage`),
  and the API client for `/api/admin/*`.
- `src/catalogue/` — the public API client and booking/quote/availability logic.
- `src/components/` — shared UI (shadcn/ui on Radix + Tailwind).
- `src/i18n/` — the translation layer; English ships, French is in progress.

## Notes

- The admin bearer token lives in `sessionStorage`, never `localStorage`, and is
  sent as `Authorization: Bearer` on every admin request.
- The calendar views use FullCalendar pinned to Africa/Kigali, and are
  lazy-loaded so their weight never reaches a public visitor.
- The server is authoritative for every amount; the app's own quote is a
  convenience and a shared fixture keeps the two in agreement.
