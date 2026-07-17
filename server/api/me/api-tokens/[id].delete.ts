import { SESSION_COOKIE, readSession } from '~~/server/utils/auth'
import { revokeApiToken } from '~~/server/utils/api-token'

// Revoke a personal access token. Returns 404 if the token doesn't exist or
// doesn't belong to the signed-in user (prevents enumeration).
export default defineEventHandler(async (event) => {
  const session = await readSession(getCookie(event, SESSION_COOKIE))
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }

  const revoked = await revokeApiToken(id, session.userId)
  if (!revoked) throw createError({ statusCode: 404, statusMessage: 'Token not found' })

  return { ok: true }
})
