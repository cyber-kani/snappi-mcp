import { SESSION_COOKIE, readSession } from '~~/server/utils/auth'
import { mintApiToken } from '~~/server/utils/api-token'

// Mint a new personal access token. The raw token is returned exactly once
// and never stored — we only keep a sha256 hash.
export default defineEventHandler(async (event) => {
  const session = await readSession(getCookie(event, SESSION_COOKIE))
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const body = await readBody<{ name?: unknown; scopes?: unknown }>(event)

  // Validate name: 1-60 chars after trim
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 60) {
    throw createError({ statusCode: 400, statusMessage: 'name must be 1–60 characters' })
  }

  // Validate scopes: must be ['read'] or ['read','write']
  const scopes = body?.scopes
  const validScopes =
    Array.isArray(scopes) &&
    (
      (scopes.length === 1 && scopes[0] === 'read') ||
      (scopes.length === 2 && scopes[0] === 'read' && scopes[1] === 'write')
    )
  if (!validScopes) {
    throw createError({ statusCode: 400, statusMessage: "scopes must be ['read'] or ['read','write']" })
  }

  const { raw, id } = await mintApiToken({
    userId: session.userId,
    name,
    scopes: scopes as string[],
    clientInfo: { via: 'manual' },
    // no expiry for manually-created tokens
  })

  return { token: raw, id }
})
