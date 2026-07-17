// Shared permission helpers for MCP tools.
//
// EVERY tool that touches board/item/workspace data MUST resolve access through
// one of these. Cross-workspace data leakage is the #1 failure mode for this
// server: a token is scoped to a *user*, and a user may only see workspaces
// they are a member of. Some existing session-cookie routes are sloppy about
// this (e.g. boards/[id].get.ts loads a board by id without a membership
// check) — MCP must NOT copy that laxness.

import { and, eq, inArray } from 'drizzle-orm'
import { useNeon, schema } from '~~/server/utils/neon'

export class AccessError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 403) {
    super(message)
    this.statusCode = statusCode
  }
}

/** All workspace ids the user is a member of. Empty array = no memberships. */
export async function memberWorkspaceIds(userId: number): Promise<number[]> {
  const db = useNeon()
  const rows = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, userId))
  return rows.map(r => r.workspaceId)
}

/** Resolve a workspace by slug, asserting the user is a member. */
export async function assertWorkspaceAccess(
  userId: number,
  slug: string,
): Promise<{ workspace: typeof schema.workspaces.$inferSelect, role: string }> {
  const db = useNeon()
  const [row] = await db
    .select({ workspace: schema.workspaces, role: schema.workspaceMembers.role })
    .from(schema.workspaces)
    .innerJoin(
      schema.workspaceMembers,
      and(
        eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
        eq(schema.workspaceMembers.userId, userId),
      ),
    )
    .where(eq(schema.workspaces.slug, slug))
    .limit(1)
  if (!row) throw new AccessError(`Workspace "${slug}" not found or you are not a member`, 404)
  return { workspace: row.workspace, role: row.role }
}

/** Load a board, asserting the user is a member of its workspace. */
export async function assertBoardAccess(
  userId: number,
  boardId: number,
): Promise<{ board: typeof schema.boards.$inferSelect, workspaceId: number }> {
  const db = useNeon()
  const [board] = await db
    .select()
    .from(schema.boards)
    .where(eq(schema.boards.id, boardId))
    .limit(1)
  if (!board) throw new AccessError(`Board ${boardId} not found`, 404)

  const [member] = await db
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(and(
      eq(schema.workspaceMembers.workspaceId, board.workspaceId),
      eq(schema.workspaceMembers.userId, userId),
    ))
    .limit(1)
  if (!member) throw new AccessError(`Board ${boardId} not found`, 404)

  return { board, workspaceId: board.workspaceId }
}

/** Load an item, asserting the user is a member of the owning workspace. */
export async function assertItemAccess(
  userId: number,
  itemId: number,
): Promise<{ item: typeof schema.items.$inferSelect, boardId: number, workspaceId: number }> {
  const db = useNeon()
  const [item] = await db
    .select()
    .from(schema.items)
    .where(eq(schema.items.id, itemId))
    .limit(1)
  if (!item) throw new AccessError(`Item ${itemId} not found`, 404)

  const { workspaceId } = await assertBoardAccess(userId, item.boardId)
  return { item, boardId: item.boardId, workspaceId }
}

/**
 * Resolve the effective set of workspace ids to query for a "list across my
 * workspaces, optionally one" tool. Throws if the named slug isn't accessible.
 * Returns null when the user has zero memberships (callers short-circuit).
 */
export async function scopeWorkspaceIds(
  userId: number,
  slug: string | undefined,
): Promise<number[] | null> {
  if (slug) {
    const { workspace } = await assertWorkspaceAccess(userId, slug)
    return [workspace.id]
  }
  const ids = await memberWorkspaceIds(userId)
  return ids.length ? ids : null
}

/** Convenience: does the user belong to *any* of these workspace ids? */
export async function filterAccessibleWorkspaceIds(
  userId: number,
  candidateIds: number[],
): Promise<number[]> {
  if (!candidateIds.length) return []
  const db = useNeon()
  const rows = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(and(
      eq(schema.workspaceMembers.userId, userId),
      inArray(schema.workspaceMembers.workspaceId, candidateIds),
    ))
  return rows.map(r => r.workspaceId)
}
