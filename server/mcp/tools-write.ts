// Write tools for the MCP server. All are requiredScope:'write'.
//
// Design rules (mirroring tools-read.ts + the existing session-cookie routes):
//   * EVERY data access is gated through assertBoardAccess / assertItemAccess /
//     assertWorkspaceAccess — never touch a board/item/workspace by id without a
//     membership check. Identity is the token principal, never a client id.
//   * Side effects mirror the equivalent /api routes exactly: same activity
//     `kind`/payload, same updatedAt bumps, same position handling, same field
//     value validation. Where the app writes notifications for the affected
//     users, we do too (kind 'comment'/'assigned'), never notifying the actor.
//   * Args are coerced/validated via ./validate; bad input throws McpArgError
//     with a readable message. Dates accept 'YYYY-MM-DD' or full ISO.
//   * Outputs are compact JSON objects and always carry ids.

import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { useNeon, schema } from '~~/server/utils/neon'
import type { ToolDef } from '~~/server/mcp/registry'
import {
  assertBoardAccess,
  assertItemAccess,
} from '~~/server/mcp/access'
import {
  enumArg,
  McpArgError,
  optBool,
  optInt,
  optString,
  reqInt,
} from '~~/server/mcp/validate'
import { STATUSES, PRIORITIES } from '~~/server/utils/schemas'

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const dt = d instanceof Date ? d : new Date(d)
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

/** name || email fallback for a user display label. */
const displayName = (name: string | null, email: string): string => (name && name.trim()) || email

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Coerce a date-ish arg into a Date. Accepts 'YYYY-MM-DD' (interpreted as
 * midnight UTC) or a full ISO timestamp. Empty/absent → undefined; explicit
 * null → null (clear). Invalid → McpArgError.
 */
function optTimestamp(args: Record<string, unknown>, key: string): Date | null | undefined {
  const v = args?.[key]
  if (v === undefined || v === '') return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new McpArgError(`"${key}" must be a date string (YYYY-MM-DD or ISO)`)
  const s = DATE_ONLY_RE.test(v) ? `${v}T00:00:00.000Z` : v
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) {
    throw new McpArgError(`"${key}" is not a valid date. Use 'YYYY-MM-DD' or a full ISO timestamp.`)
  }
  return d
}

/** A plain calendar-date arg ('YYYY-MM-DD') for personal tasks (date column). */
function optDateOnly(args: Record<string, unknown>, key: string): string | null | undefined {
  const v = args?.[key]
  if (v === undefined || v === '') return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new McpArgError(`"${key}" must be a date string (YYYY-MM-DD)`)
  // Accept full ISO too, but store just the date part.
  const dateStr = DATE_ONLY_RE.test(v) ? v : v.slice(0, 10)
  if (!DATE_ONLY_RE.test(dateStr)) {
    throw new McpArgError(`"${key}" must be a calendar date in 'YYYY-MM-DD' form`)
  }
  const probe = new Date(`${dateStr}T00:00:00.000Z`)
  if (Number.isNaN(probe.getTime())) throw new McpArgError(`"${key}" is not a valid date`)
  return dateStr
}

/** Compact item summary shared by create/update/move outputs. */
async function itemSummary(itemId: number) {
  const db = useNeon()
  const [it] = await db.select().from(schema.items).where(eq(schema.items.id, itemId)).limit(1)
  if (!it) return null
  const assignees = await db.select({ userId: schema.itemAssignees.userId })
    .from(schema.itemAssignees).where(eq(schema.itemAssignees.itemId, itemId))
  return {
    id: Number(it.id),
    name: it.name,
    boardId: Number(it.boardId),
    groupId: Number(it.groupId),
    status: it.status,
    priority: it.priority,
    dueDate: iso(it.dueDate),
    notes: it.notes,
    archivedAt: iso(it.archivedAt),
    createdBy: it.createdBy ? Number(it.createdBy) : null,
    assigneeIds: assignees.map(a => Number(a.userId)),
    updatedAt: iso(it.updatedAt),
  }
}

/** Resolve a `user` arg (numeric id OR email) to a member of a workspace. */
async function resolveWorkspaceMember(
  workspaceId: number,
  userArg: unknown,
): Promise<{ id: number, name: string | null, email: string }> {
  const db = useNeon()
  // Email path.
  if (typeof userArg === 'string' && userArg.includes('@')) {
    const email = userArg.trim().toLowerCase()
    const [row] = await db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .innerJoin(schema.workspaceMembers, and(
        eq(schema.workspaceMembers.userId, schema.users.id),
        eq(schema.workspaceMembers.workspaceId, workspaceId),
      ))
      .where(eq(schema.users.email, email))
      .limit(1)
    if (!row) throw new McpArgError(`No workspace member found with email "${userArg}"`)
    return { id: Number(row.id), name: row.name, email: row.email }
  }
  // Numeric id path.
  const idNum = typeof userArg === 'number' ? userArg : Number(userArg)
  if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
    throw new McpArgError('"user" must be a positive user id or an email address')
  }
  const [row] = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .innerJoin(schema.workspaceMembers, and(
      eq(schema.workspaceMembers.userId, schema.users.id),
      eq(schema.workspaceMembers.workspaceId, workspaceId),
    ))
    .where(eq(schema.users.id, idNum))
    .limit(1)
  if (!row) throw new McpArgError(`User ${idNum} is not a member of this item's workspace`)
  return { id: Number(row.id), name: row.name, email: row.email }
}

// ============================================================
// 1. create_item
// ============================================================
const createItem: ToolDef = {
  name: 'create_item',
  description:
    'Create a new work item (task/lead/row) on a board. Provide the board_id (from list_boards). '
    + 'If group_id is omitted the item lands in the board\'s first group. '
    + 'status is one of not_started | working_on_it | stuck | done (default not_started); '
    + 'priority is one of low | medium | high | urgent (default medium). '
    + 'due_date accepts \'YYYY-MM-DD\' or a full ISO timestamp. Returns the created item incl. its id.',
  inputSchema: {
    type: 'object',
    properties: {
      board_id: { type: 'integer', description: 'The board id to create the item on (from list_boards).' },
      name: { type: 'string', description: 'The item title.' },
      group_id: { type: 'integer', description: 'Optional. Target group id (from get_board). Defaults to the board\'s first group.' },
      status: { type: 'string', enum: [...STATUSES], description: 'Optional. Item status. Default not_started.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Optional. Item priority. Default medium.' },
      due_date: { type: 'string', description: 'Optional. Due date as YYYY-MM-DD or ISO timestamp.' },
      notes: { type: 'string', description: 'Optional. Free-text notes/description.' },
    },
    required: ['board_id', 'name'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const boardId = reqInt(args, 'board_id')
    const name = optString(args, 'name')
    if (!name || !name.trim()) throw new McpArgError('"name" is required')
    if (name.length > 200) throw new McpArgError('"name" is too long (max 200)')
    const status = args.status === undefined || args.status === null || args.status === ''
      ? 'not_started'
      : enumArg(args, 'status', STATUSES)
    const priority = args.priority === undefined || args.priority === null || args.priority === ''
      ? 'medium'
      : enumArg(args, 'priority', PRIORITIES)
    const dueDate = optTimestamp(args, 'due_date')
    const notes = optString(args, 'notes')
    const groupIdArg = optInt(args, 'group_id')

    const { board } = await assertBoardAccess(principal.userId, boardId)
    const db = useNeon()

    // Resolve the target group: explicit (validated to belong to the board) or
    // the board's first group by position.
    let groupId: number
    if (groupIdArg !== undefined) {
      const [g] = await db.select({ id: schema.groups.id, boardId: schema.groups.boardId })
        .from(schema.groups).where(eq(schema.groups.id, groupIdArg)).limit(1)
      if (!g || Number(g.boardId) !== boardId) {
        throw new McpArgError(`Group ${groupIdArg} does not belong to board ${boardId}`)
      }
      groupId = Number(g.id)
    } else {
      const [first] = await db.select({ id: schema.groups.id })
        .from(schema.groups).where(eq(schema.groups.boardId, boardId))
        .orderBy(asc(schema.groups.position), asc(schema.groups.id)).limit(1)
      if (!first) throw new McpArgError(`Board ${board.id} has no groups to add an item to`)
      groupId = Number(first.id)
    }

    const [last] = await db.select({ position: schema.items.position })
      .from(schema.items).where(eq(schema.items.groupId, groupId))
      .orderBy(desc(schema.items.position)).limit(1)

    const [created] = await db.insert(schema.items).values({
      boardId,
      groupId,
      name: name.trim(),
      status,
      priority,
      dueDate: dueDate ?? null,
      notes: notes ?? null,
      position: (last?.position ?? 0) + 1,
      createdBy: principal.userId,
    }).returning()
    if (!created) throw new McpArgError('Failed to create item')

    await db.insert(schema.activity).values({
      boardId,
      itemId: created.id,
      userId: principal.userId,
      kind: 'item.created',
      payload: { name: created.name },
    })

    return { item: await itemSummary(Number(created.id)) }
  },
}

// ============================================================
// 2. update_item
// ============================================================
const updateItem: ToolDef = {
  name: 'update_item',
  description:
    'Update fields on an existing work item (partial — only pass what changes). '
    + 'Supports name, status (not_started|working_on_it|stuck|done), priority (low|medium|high|urgent), '
    + 'due_date (YYYY-MM-DD or ISO; pass empty to clear), notes, group_id (moves the item to another '
    + 'group on the SAME board), and archived (true archives, false restores). '
    + 'Get an item_id from get_board, search_items, or my_tasks. Returns the updated item summary.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id.' },
      name: { type: 'string', description: 'Optional. New title.' },
      status: { type: 'string', enum: [...STATUSES], description: 'Optional. New status.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Optional. New priority.' },
      due_date: { type: 'string', description: 'Optional. New due date (YYYY-MM-DD or ISO). Empty string clears it.' },
      notes: { type: 'string', description: 'Optional. New notes.' },
      group_id: { type: 'integer', description: 'Optional. Move the item to this group (must be on the same board).' },
      archived: { type: 'boolean', description: 'Optional. true archives the item, false restores it.' },
    },
    required: ['item_id'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const { item, boardId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const patch: Partial<typeof schema.items.$inferInsert> = { updatedAt: new Date() }
    const logged: Record<string, unknown> = {}

    const name = optString(args, 'name')
    if (name !== undefined) {
      if (!name.trim()) throw new McpArgError('"name" cannot be empty')
      if (name.length > 200) throw new McpArgError('"name" is too long (max 200)')
      patch.name = name.trim()
      logged.name = patch.name
    }
    if (args.status !== undefined && args.status !== null && args.status !== '') {
      patch.status = enumArg(args, 'status', STATUSES)
      logged.status = patch.status
    }
    if (args.priority !== undefined && args.priority !== null && args.priority !== '') {
      patch.priority = enumArg(args, 'priority', PRIORITIES)
      logged.priority = patch.priority
    }
    const due = optTimestamp(args, 'due_date')
    if (due !== undefined) {
      patch.dueDate = due
      logged.dueDate = due ? iso(due) : null
    }
    const notes = args.notes === null ? null : optString(args, 'notes')
    if (notes !== undefined || args.notes === null) {
      if (notes && notes.length > 2000) throw new McpArgError('"notes" is too long (max 2000)')
      patch.notes = notes ?? null
      logged.notes = patch.notes
    }
    const groupIdArg = optInt(args, 'group_id')
    if (groupIdArg !== undefined) {
      const [g] = await db.select({ id: schema.groups.id, boardId: schema.groups.boardId })
        .from(schema.groups).where(eq(schema.groups.id, groupIdArg)).limit(1)
      if (!g || Number(g.boardId) !== boardId) {
        throw new McpArgError(`Group ${groupIdArg} does not belong to this item's board`)
      }
      patch.groupId = Number(g.id)
      logged.groupId = patch.groupId
    }
    const archived = optBool(args, 'archived')
    if (archived !== undefined) {
      patch.archivedAt = archived ? new Date() : null
      logged.archivedAt = patch.archivedAt ? iso(patch.archivedAt) : null
    }

    if (Object.keys(logged).length === 0) {
      throw new McpArgError('Nothing to update — provide at least one field to change.')
    }

    await db.update(schema.items).set(patch).where(eq(schema.items.id, itemId))

    await db.insert(schema.activity).values({
      boardId: item.boardId,
      itemId,
      userId: principal.userId,
      kind: 'item.updated',
      payload: logged as Record<string, unknown>,
    })

    return { item: await itemSummary(itemId) }
  },
}

// ============================================================
// 3. set_field_value
// ============================================================
const setFieldValue: ToolDef = {
  name: 'set_field_value',
  description:
    'Set one custom column value on an item, addressed by the column\'s stable key (from get_board\'s '
    + 'columns[].key). Value handling by column kind: status/dropdown accept an option id OR a '
    + 'case-insensitive option label (stored as the option id); person accepts an array of user ids or '
    + 'member emails (stored as ids); number/currency/rating accept a number; date accepts YYYY-MM-DD or '
    + 'ISO; multi_select accepts an array of ids/labels; text/email/phone/url/long_text accept a string. '
    + 'Pass null to clear. Mirrors the board UI\'s status-to-group automation. Returns {column, storedValue}.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id.' },
      column_key: { type: 'string', description: 'The column key (from get_board columns[].key).' },
      value: { description: 'The value to store. Type depends on the column kind (see description). null clears.' },
    },
    required: ['item_id', 'column_key'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const columnKey = optString(args, 'column_key')
    if (!columnKey) throw new McpArgError('"column_key" is required')
    const raw = args.value

    const { item, boardId, workspaceId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const columns = await db.select().from(schema.boardColumns)
      .where(eq(schema.boardColumns.boardId, boardId))
      .orderBy(asc(schema.boardColumns.position))
    const col = columns.find(c => c.key === columnKey)
    if (!col) {
      const keys = columns.map(c => `${c.key} (${c.kind})`).join(', ') || '(none)'
      throw new McpArgError(`No column with key "${columnKey}" on this board. Available keys: ${keys}`)
    }

    // Coerce/validate incoming value against the column kind → stored jsonb value.
    let stored: unknown
    const clearing = raw === null || raw === undefined || raw === ''

    type Option = { id?: string, label?: string, color?: string }
    const options: Option[] = (col.config as { options?: Option[] } | null)?.options ?? []

    const resolveOption = (v: unknown): string => {
      if (typeof v !== 'string') throw new McpArgError(`"${col.key}" expects an option id or label`)
      const byId = options.find(o => o.id === v)
      if (byId?.id) return byId.id
      const byLabel = options.find(o => (o.label ?? '').trim().toLowerCase() === v.trim().toLowerCase())
      if (byLabel?.id) return byLabel.id
      const avail = options.map(o => o.label ?? o.id).filter(Boolean).join(', ') || '(none)'
      throw new McpArgError(`"${v}" is not a valid option for "${col.key}". Options: ${avail}`)
    }

    if (clearing) {
      stored = null
    } else {
      switch (col.kind) {
        case 'status':
        case 'dropdown': {
          stored = resolveOption(raw)
          break
        }
        case 'multi_select': {
          const arr = Array.isArray(raw) ? raw : [raw]
          stored = arr.map(resolveOption)
          break
        }
        case 'person': {
          const arr = Array.isArray(raw) ? raw : [raw]
          const ids: number[] = []
          for (const u of arr) {
            const m = await resolveWorkspaceMember(workspaceId, u)
            ids.push(m.id)
          }
          stored = ids
          break
        }
        case 'number':
        case 'currency':
        case 'rating': {
          const n = typeof raw === 'number' ? raw : Number(raw)
          if (!Number.isFinite(n)) throw new McpArgError(`"${col.key}" expects a number`)
          stored = n
          break
        }
        case 'date': {
          const d = optTimestamp({ v: raw }, 'v')
          stored = d ? d.toISOString() : null
          break
        }
        default: {
          // text / long_text / email / phone / url
          if (typeof raw !== 'string') throw new McpArgError(`"${col.key}" expects a string`)
          stored = raw
        }
      }
    }

    if (stored === null) {
      await db.delete(schema.itemFieldValues)
        .where(and(eq(schema.itemFieldValues.itemId, itemId), eq(schema.itemFieldValues.columnId, col.id)))
    } else {
      await db.insert(schema.itemFieldValues)
        .values({ itemId, columnId: col.id, value: stored as unknown as never, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.itemFieldValues.itemId, schema.itemFieldValues.columnId],
          set: { value: stored as unknown as never, updatedAt: new Date() },
        })
    }

    // Status-to-group automation (mirrors values.post.ts): if this is a status
    // column and the new option label matches a group name on the same board,
    // move the item to that group (end position).
    let movedToGroupId: number | null = null
    if (col.kind === 'status' && typeof stored === 'string' && stored) {
      const opt = options.find(o => o.id === stored)
      if (opt?.label) {
        const target = opt.label.trim().toLowerCase()
        const groups = await db.select({ id: schema.groups.id, name: schema.groups.name })
          .from(schema.groups).where(eq(schema.groups.boardId, boardId))
          .orderBy(asc(schema.groups.position))
        const match = groups.find(g => g.name.trim().toLowerCase() === target)
        if (match && Number(match.id) !== Number(item.groupId)) {
          const [tail] = await db.select({ position: schema.items.position }).from(schema.items)
            .where(eq(schema.items.groupId, match.id))
            .orderBy(desc(schema.items.position)).limit(1)
          await db.update(schema.items)
            .set({ groupId: match.id, position: (tail?.position ?? -1) + 1, updatedAt: new Date() })
            .where(eq(schema.items.id, itemId))
          movedToGroupId = Number(match.id)
        }
      }
    }
    if (movedToGroupId === null) {
      await db.update(schema.items).set({ updatedAt: new Date() }).where(eq(schema.items.id, itemId))
    }

    await db.insert(schema.activity).values({
      boardId,
      itemId,
      userId: principal.userId,
      kind: 'item.updated',
      payload: { column: col.key, value: stored } as Record<string, unknown>,
    })

    return {
      column: { id: Number(col.id), key: col.key, label: col.label, kind: col.kind },
      storedValue: stored,
      movedToGroupId,
    }
  },
}

// ============================================================
// 4. add_comment
// ============================================================
const addComment: ToolDef = {
  name: 'add_comment',
  description:
    'Post a comment/update on a work item as the current user (like the item\'s Updates panel). '
    + 'Notifies the item\'s assignees (except the author). Get an item_id from get_board, search_items, '
    + 'or my_tasks. Returns the new comment id and createdAt.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id to comment on.' },
      body: { type: 'string', description: 'The comment text (supports @username mentions).' },
    },
    required: ['item_id', 'body'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const body = optString(args, 'body')
    if (!body || !body.trim()) throw new McpArgError('"body" is required')
    if (body.length > 8000) throw new McpArgError('"body" is too long (max 8000)')

    const { item, boardId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const mentionUsernames = Array.from(new Set(
      [...body.matchAll(/@([a-zA-Z0-9._-]{2,40})/g)].map(m => m[1]),
    ))

    const [created] = await db.insert(schema.itemComments).values({
      itemId,
      userId: principal.userId,
      body,
      mentions: mentionUsernames.length ? mentionUsernames : [],
    }).returning()
    if (!created) throw new McpArgError('Failed to create comment')

    await db.insert(schema.activity).values({
      boardId,
      itemId,
      userId: principal.userId,
      kind: 'item.commented',
      payload: { preview: body.slice(0, 120) } as Record<string, unknown>,
    })

    // Notify the item's assignees (except the author) that a comment landed.
    const assignees = await db.select({ userId: schema.itemAssignees.userId })
      .from(schema.itemAssignees)
      .where(and(eq(schema.itemAssignees.itemId, itemId), ne(schema.itemAssignees.userId, principal.userId)))
    if (assignees.length) {
      await db.insert(schema.notifications).values(assignees.map(a => ({
        userId: Number(a.userId),
        kind: 'comment',
        payload: {
          itemId,
          itemName: item.name,
          boardId,
          commentId: Number(created.id),
          by: principal.userId,
          preview: body.slice(0, 120),
        } as Record<string, unknown>,
      })))
    }

    return { comment: { id: Number(created.id), createdAt: iso(created.createdAt) } }
  },
}

// ============================================================
// 5. assign_item
// ============================================================
const assignItem: ToolDef = {
  name: 'assign_item',
  description:
    'Add or remove an assignee (the built-in owner field) on a work item. `user` is a user id OR the '
    + 'email of a member of the item\'s workspace; action is "add" or "remove". Use list_members to find '
    + 'a teammate\'s id/email. Adding notifies the assigned user. Returns the current assignee list.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id.' },
      user: { type: ['integer', 'string'], description: 'The user id (integer) or email of a workspace member.' },
      action: { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove this assignee.' },
    },
    required: ['item_id', 'user', 'action'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const action = enumArg(args, 'action', ['add', 'remove'] as const)
    if (args.user === undefined || args.user === null || args.user === '') {
      throw new McpArgError('"user" is required (a user id or email)')
    }

    const { item, boardId, workspaceId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const member = await resolveWorkspaceMember(workspaceId, args.user)

    const [existing] = await db.select().from(schema.itemAssignees)
      .where(and(eq(schema.itemAssignees.itemId, itemId), eq(schema.itemAssignees.userId, member.id)))
      .limit(1)

    if (action === 'add') {
      if (!existing) {
        await db.insert(schema.itemAssignees).values({ itemId, userId: member.id })
        await db.insert(schema.activity).values({
          boardId,
          itemId,
          userId: member.id,
          kind: 'item.assigned',
          payload: { userId: member.id },
        })
        // Notify the newly assigned user (unless they assigned themselves).
        if (member.id !== principal.userId) {
          await db.insert(schema.notifications).values({
            userId: member.id,
            kind: 'assigned',
            payload: { itemId, itemName: item.name, boardId, by: principal.userId } as Record<string, unknown>,
          })
        }
      }
    } else {
      if (existing) {
        await db.delete(schema.itemAssignees)
          .where(and(eq(schema.itemAssignees.itemId, itemId), eq(schema.itemAssignees.userId, member.id)))
        await db.insert(schema.activity).values({
          boardId,
          itemId,
          userId: member.id,
          kind: 'item.unassigned',
          payload: { userId: member.id },
        })
      }
    }

    // Current assignee list (with names).
    const rows = await db.select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
      .from(schema.itemAssignees)
      .innerJoin(schema.users, eq(schema.users.id, schema.itemAssignees.userId))
      .where(eq(schema.itemAssignees.itemId, itemId))
      .orderBy(asc(schema.users.name))

    return {
      itemId,
      assignees: rows.map(r => ({ id: Number(r.id), name: displayName(r.name, r.email), email: r.email })),
    }
  },
}

// ============================================================
// 6. move_item
// ============================================================
const moveItem: ToolDef = {
  name: 'move_item',
  description:
    'Move a work item to a different group on the SAME board (a convenience wrapper — update_item can '
    + 'also move via its group_id argument). The target group must belong to the item\'s board. '
    + 'Returns the updated item summary.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id to move.' },
      group_id: { type: 'integer', description: 'The destination group id (must be on the same board).' },
    },
    required: ['item_id', 'group_id'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const groupId = reqInt(args, 'group_id')
    const { item, boardId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const [g] = await db.select({ id: schema.groups.id, boardId: schema.groups.boardId })
      .from(schema.groups).where(eq(schema.groups.id, groupId)).limit(1)
    if (!g || Number(g.boardId) !== boardId) {
      throw new McpArgError(`Group ${groupId} does not belong to this item's board`)
    }

    if (Number(item.groupId) !== groupId) {
      const [tail] = await db.select({ position: schema.items.position }).from(schema.items)
        .where(eq(schema.items.groupId, groupId))
        .orderBy(desc(schema.items.position)).limit(1)
      await db.update(schema.items)
        .set({ groupId, position: (tail?.position ?? -1) + 1, updatedAt: new Date() })
        .where(eq(schema.items.id, itemId))
      await db.insert(schema.activity).values({
        boardId,
        itemId,
        userId: principal.userId,
        kind: 'item.updated',
        payload: { groupId },
      })
    }

    return { item: await itemSummary(itemId) }
  },
}

// ============================================================
// 7. create_personal_task
// ============================================================
const createPersonalTask: ToolDef = {
  name: 'create_personal_task',
  description:
    'Add a to-do to the current user\'s PRIVATE personal checklist ("Personal List" — not tied to any '
    + 'board). Optional due_date is a plain calendar date \'YYYY-MM-DD\'. Returns the created task. '
    + 'For a task that belongs on a board, use create_item instead.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The to-do text.' },
      due_date: { type: 'string', description: 'Optional. Calendar date YYYY-MM-DD.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const text = optString(args, 'text')
    if (!text || !text.trim()) throw new McpArgError('"text" is required')
    if (text.trim().length > 500) throw new McpArgError('"text" is too long (max 500)')
    const dueDate = optDateOnly(args, 'due_date') ?? null

    const db = useNeon()
    const [tail] = await db.select({ position: schema.personalTasks.position })
      .from(schema.personalTasks)
      .where(eq(schema.personalTasks.userId, principal.userId))
      .orderBy(desc(schema.personalTasks.position)).limit(1)
    const nextPos = (tail?.position ?? -1) + 1

    const [row] = await db.insert(schema.personalTasks).values({
      userId: principal.userId,
      text: text.trim(),
      dueDate,
      position: nextPos,
    }).returning()
    if (!row) throw new McpArgError('Failed to create personal task')

    return {
      task: {
        id: Number(row.id),
        text: row.text,
        done: !!row.doneAt,
        dueDate: row.dueDate ?? null,
        createdAt: iso(row.createdAt),
      },
    }
  },
}

// ============================================================
// 8. update_personal_task
// ============================================================
const updatePersonalTask: ToolDef = {
  name: 'update_personal_task',
  description:
    'Edit a personal-checklist to-do owned by the current user: change its text, set/clear its due_date '
    + '(\'YYYY-MM-DD\', or empty to clear), or mark it done/undone (done=true sets completion, false '
    + 'reopens). Only the owner\'s own tasks are editable. Returns the updated task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The personal task id (from list_personal_tasks).' },
      text: { type: 'string', description: 'Optional. New to-do text.' },
      due_date: { type: 'string', description: 'Optional. New due date YYYY-MM-DD; empty string clears it.' },
      done: { type: 'boolean', description: 'Optional. true marks done, false reopens.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const id = reqInt(args, 'id')
    const patch: Partial<typeof schema.personalTasks.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() }
    let touched = false

    const text = optString(args, 'text')
    if (text !== undefined) {
      if (!text.trim()) throw new McpArgError('"text" cannot be empty')
      if (text.trim().length > 500) throw new McpArgError('"text" is too long (max 500)')
      patch.text = text.trim()
      touched = true
    }
    if ('due_date' in (args ?? {})) {
      const dd = optDateOnly(args, 'due_date')
      patch.dueDate = dd ?? null
      touched = true
    }
    const done = optBool(args, 'done')
    if (done !== undefined) {
      patch.doneAt = done ? new Date() : null
      touched = true
    }
    if (!touched) throw new McpArgError('Nothing to update — provide text, due_date, or done.')

    const db = useNeon()
    const [row] = await db.update(schema.personalTasks)
      .set(patch)
      .where(and(
        eq(schema.personalTasks.id, id),
        eq(schema.personalTasks.userId, principal.userId),
      ))
      .returning()
    if (!row) throw new McpArgError(`Personal task ${id} not found (or not yours)`)

    return {
      task: {
        id: Number(row.id),
        text: row.text,
        done: !!row.doneAt,
        doneAt: iso(row.doneAt),
        dueDate: row.dueDate ?? null,
        updatedAt: iso(row.updatedAt),
      },
    }
  },
}

// ============================================================
// 9. delete_personal_task
// ============================================================
const deletePersonalTask: ToolDef = {
  name: 'delete_personal_task',
  description:
    'Delete a to-do from the current user\'s PRIVATE personal checklist. Only the owner\'s own tasks can '
    + 'be deleted. Returns {deleted:true, id} on success.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The personal task id (from list_personal_tasks).' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  requiredScope: 'write',
  async handler(args, principal) {
    const id = reqInt(args, 'id')
    const db = useNeon()
    const deleted = await db.delete(schema.personalTasks)
      .where(and(
        eq(schema.personalTasks.id, id),
        eq(schema.personalTasks.userId, principal.userId),
      ))
      .returning({ id: schema.personalTasks.id })
    if (!deleted.length) throw new McpArgError(`Personal task ${id} not found (or not yours)`)
    return { deleted: true, id }
  },
}

export const writeTools: ToolDef[] = [
  createItem,
  updateItem,
  setFieldValue,
  addComment,
  assignItem,
  moveItem,
  createPersonalTask,
  updatePersonalTask,
  deletePersonalTask,
]
