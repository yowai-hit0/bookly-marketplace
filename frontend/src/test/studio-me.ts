/**
 * `GET /api/studio/me`, which the studio layout asks for on every visit to
 * draw the pending or suspended banner (Phase 2). Page tests answer it with
 * this and leave it out of the calls they count, so each one still counts
 * only the requests its own page makes.
 */

export const STUDIO_ME_URL = '/api/studio/me'

export type StudioStatus = 'pending' | 'approved' | 'suspended'

export function studioMeBody(status: StudioStatus = 'approved') {
  return {
    user: { id: 'a1', email: 'photographer@bookly.example', lastLoginAt: null },
    photographer: { id: 'p1', handle: 'kigali-lens', displayName: 'Kigali Lens', status },
  }
}

export function studioMe(status: StudioStatus = 'approved'): Response {
  return new Response(JSON.stringify(studioMeBody(status)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** True for the layout's own request, which a page test leaves out of its counts. */
export function isStudioMe(input: string | URL | Request): boolean {
  return String(input instanceof Request ? input.url : input) === STUDIO_ME_URL
}
