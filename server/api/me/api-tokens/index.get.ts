import { SESSION_COOKIE, readSession } from '~~/server/utils/auth'
import { listApiTokens } from '~~/server/utils/api-token'

// Returns all active (non-revoked) API tokens for the signed-in user.
// Safe fields only — tokenHash is never returned.
export default defineEventHandler(async (event) => {
  const session = await readSession(getCookie(event, SESSION_COOKIE))
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const all = await listApiTokens(session.userId)
  // Filter out revoked tokens — UI shows active only
  const tokens = all
    .filter(t => !t.revokedAt)
    .map(t => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      scopes: t.scopes,
      clientInfo: t.clientInfo,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
    }))

  return { tokens }
})
