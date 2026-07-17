import { and, eq } from 'drizzle-orm'
import { useNeon, schema } from '~~/server/utils/neon'
import { randomToken, sha256Hex } from '~~/server/utils/auth'

// ============================================================
// API tokens (MCP server / personal access tokens)
//
// Raw token format: `snappi_` + randomToken(32). Shown to the user exactly
// once at mint time — we only persist sha256Hex(raw) as the lookup hash and
// raw.slice(0,12) as a display prefix. Everything here reuses the edge-safe
// crypto helpers in auth.ts.
// ============================================================

const TOKEN_PREFIX = 'snappi_'
const TOKEN_BYTES = 32
// Skip updating last_used_at unless it's this stale — avoids a write on
// every single authenticated request.
const LAST_USED_STALE_MS = 5 * 60 * 1000

export type ApiTokenPrincipal = {
  tokenId: number
  userId: number
  email: string
  name: string | null
  scopes: string[]
}

export async function mintApiToken(opts: {
  userId: number
  name: string
  scopes?: string[]
  clientInfo?: Record<string, unknown>
  expiresInSeconds?: number
}): Promise<{ raw: string, id: number }> {
  const raw = TOKEN_PREFIX + randomToken(TOKEN_BYTES)
  const tokenHash = await sha256Hex(raw)
  const expiresAt = opts.expiresInSeconds
    ? new Date(Date.now() + opts.expiresInSeconds * 1000)
    : null

  const db = useNeon()
  const [row] = await db.insert(schema.apiTokens).values({
    userId: opts.userId,
    name: opts.name,
    tokenHash,
    tokenPrefix: raw.slice(0, 12),
    scopes: opts.scopes ?? ['read', 'write'],
    clientInfo: opts.clientInfo ?? { via: 'manual' },
    expiresAt,
  }).returning({ id: schema.apiTokens.id })

  if (!row) throw new Error('failed to insert api token')
  return { raw, id: row.id }
}

export async function readApiToken(
  authorizationHeader: string | undefined | null,
): Promise<ApiTokenPrincipal | null> {
  if (!authorizationHeader) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim())
  if (!match || !match[1]) return null
  const raw = match[1].trim()
  if (!raw.startsWith(TOKEN_PREFIX)) return null

  const tokenHash = await sha256Hex(raw)
  const db = useNeon()
  const [row] = await db
    .select({
      tokenId: schema.apiTokens.id,
      userId: schema.apiTokens.userId,
      scopes: schema.apiTokens.scopes,
      revokedAt: schema.apiTokens.revokedAt,
      expiresAt: schema.apiTokens.expiresAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      email: schema.users.email,
      name: schema.users.name,
      suspendedAt: schema.users.suspendedAt,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.tokenHash, tokenHash))
    .limit(1)

  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  if (row.suspendedAt) return null

  // Fire-and-forget touch of last_used_at, but only if it's stale enough that
  // the write is worth it — keeps hot-path reads from writing every request.
  const stale = !row.lastUsedAt || (Date.now() - row.lastUsedAt.getTime()) > LAST_USED_STALE_MS
  if (stale) {
    void db.update(schema.apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiTokens.id, row.tokenId))
      .catch((err) => { console.error('[api-token] lastUsedAt update failed', err) })
  }

  return {
    tokenId: row.tokenId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    scopes: Array.isArray(row.scopes) ? row.scopes as string[] : [],
  }
}

export async function revokeApiToken(tokenId: number, userId: number): Promise<boolean> {
  const db = useNeon()
  const updated = await db.update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(schema.apiTokens.id, tokenId),
      eq(schema.apiTokens.userId, userId),
    ))
    .returning({ id: schema.apiTokens.id })
  return updated.length > 0
}

export async function listApiTokens(userId: number) {
  const db = useNeon()
  return db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      tokenPrefix: schema.apiTokens.tokenPrefix,
      scopes: schema.apiTokens.scopes,
      clientInfo: schema.apiTokens.clientInfo,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      expiresAt: schema.apiTokens.expiresAt,
      revokedAt: schema.apiTokens.revokedAt,
      createdAt: schema.apiTokens.createdAt,
    })
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.userId, userId))
}
