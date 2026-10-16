import { z } from 'zod'

/** Thrown when required configuration is missing or malformed. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError'

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
  }
}

// Dev default is a bare path, proxied to Express by Vite on localhost. Every
// deployed environment is cross-origin now — frontend and backend are two
// separately-deployed apps on separate domains (spec §7, revision 2.2) — so
// production must set an absolute http(s) URL instead.
const schema = z.object({
  VITE_API_BASE_URL: z.union([z.string().startsWith('/'), z.url()]).default('/api'),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, unknown> = import.meta.env): Env {
  const result = schema.safeParse(source)
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }
  return result.data
}

export const env = parseEnv()
