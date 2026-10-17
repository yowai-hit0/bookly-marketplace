import { vi } from 'vitest'

/** One request the page made, as the tests read it back. */
export type Sent = { url: string; method: string; body: unknown; headers: Headers }

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Stubs `fetch` with `respond`, keyed by method and URL, and records every
 * call. A request `respond` does not answer is a 404, so nothing leaks to
 * the network.
 */
export function stubApi(respond: (sent: Sent) => Response | Promise<Response> | undefined) {
  const sent: Sent[] = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Sent = {
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: new Headers(init.headers),
    }
    sent.push(call)
    return (await respond(call)) ?? json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', mock)
  return { sent, mock }
}
