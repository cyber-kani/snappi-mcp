// Read tools for the MCP server. All are requiredScope:'read'.
//
// Design rules followed throughout:
//   * Every query is scoped to workspaces the principal's user belongs to,
//     via the helpers in ./access — no board/item is reachable without a
//     membership check.
//   * Outputs are compact JSON objects and always carry ids so an LLM can
//     chain a follow-up call (get_board → get_item, list_members → assign …).
//   * Dates are emitted as ISO strings (or null).
//   * List sizes are capped with sensible defaults + a `limit` arg.
//   * Option ids resolve to labels, person ids resolve to names.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { useNeon, schema } from '~~/server/utils/neon'
import type { ToolDef } from '~~/server/mcp/registry'
import {
  assertBoardAccess,
  assertItemAccess,
  assertWorkspaceAccess,
  scopeWorkspaceIds,
} from '~~/server/mcp/access'
import {
  collectPersonUserIds,
  resolveItemFields,
} from '~~/server/mcp/resolve'
import { isParked } from '~~/server/utils/task-parked'
import {
  enumArg,
  limitArg,
  optBool,
  optString,
  reqInt,
} from '~~/server/mcp/validate'

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const dt = d instanceof Date ? d : new Date(d)
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

/** name || email fallback for a user display label. */
const displayName = (name: string | null, email: string): string => (name && name.trim()) || email

// ============================================================
// 1. list_workspaces
// ============================================================
const listWorkspaces: ToolDef = {
  name: 'list_workspaces',
  description:
    'List every workspace the user is a member of, with their role and how many boards each contains. '
    + 'Use this first to discover which workspaces exist before drilling into boards or items. '
    + 'A workspace is a top-level container (like a team or company) holding boards.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiredScope: 'read',
  async handler(_args, principal) {
    const db = useNeon()
    const rows = await db
      .select({
        id: schema.workspaces.id,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        role: schema.workspaceMembers.role,
        boardCount: sql<number>`count(${schema.boards.id})::int`,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaceMembers.workspaceId, schema.workspaces.id))
      .leftJoin(schema.boards, eq(schema.boards.workspaceId, schema.workspaces.id))
      .where(eq(schema.workspaceMembers.userId, principal.userId))
      .groupBy(schema.workspaces.id, schema.workspaceMembers.role)
      .orderBy(asc(schema.workspaces.createdAt))
    return {
      workspaces: rows.map(w => ({
        id: Number(w.id),
        slug: w.slug,
        name: w.name,
        role: w.role,
        boardCount: Number(w.boardCount),
      })),
    }
  },
}

// ============================================================
// 2. list_boards
// ============================================================
const listBoards: ToolDef = {
  name: 'list_boards',
  description:
    'List boards across the workspaces the user belongs to, optionally restricted to one workspace by slug. '
    + 'A board is a table/grid of work items (tasks, leads, projects). Returns each board id, name, '
    + 'its workspace slug, its template type, and its live (non-archived) item count. '
    + 'Use get_board to see a board\'s columns, groups, and items.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_slug: {
        type: 'string',
        description: 'Optional. Restrict to a single workspace by its slug (from list_workspaces).',
      },
    },
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const slug = optString(args, 'workspace_slug')
    const wsIds = await scopeWorkspaceIds(principal.userId, slug)
    if (!wsIds) return { boards: [] }
    const db = useNeon()
    const rows = await db
      .select({
        id: schema.boards.id,
        name: schema.boards.name,
        slug: schema.boards.slug,
        template: schema.boards.template,
        workspaceSlug: schema.workspaces.slug,
        itemCount: sql<number>`count(${schema.items.id}) filter (where ${schema.items.archivedAt} is null)::int`,
      })
      .from(schema.boards)
      .innerJoin(schema.workspaces, eq(schema.boards.workspaceId, schema.workspaces.id))
      .leftJoin(schema.items, eq(schema.items.boardId, schema.boards.id))
      .where(inArray(schema.boards.workspaceId, wsIds))
      .groupBy(schema.boards.id, schema.workspaces.slug)
      .orderBy(asc(schema.workspaces.slug), asc(schema.boards.position))
    return {
      boards: rows.map(b => ({
        id: Number(b.id),
        name: b.name,
        slug: b.slug,
        workspaceSlug: b.workspaceSlug,
        template: b.template,
        itemCount: Number(b.itemCount),
      })),
    }
  },
}

// ============================================================
// 3. get_board
// ============================================================
const getBoard: ToolDef = {
  name: 'get_board',
  description:
    'Get one board in full: its metadata, column definitions (id, key, label, kind, and for '
    + 'status/dropdown columns their option labels), and its groups each containing their items. '
    + 'Each item includes id, name, status, priority, due date, assignees, and resolved custom field '
    + 'values (status/dropdown option ids resolved to labels, person ids resolved to names). '
    + 'Use this to answer "what is on board X" or "show me the tasks in <board>". Get a board_id from list_boards.',
  inputSchema: {
    type: 'object',
    properties: {
      board_id: { type: 'integer', description: 'The board id (from list_boards).' },
      include_archived: {
        type: 'boolean',
        description: 'Include archived items too. Defaults to false (live items only).',
      },
    },
    required: ['board_id'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const boardId = reqInt(args, 'board_id')
    const includeArchived = optBool(args, 'include_archived') ?? false
    const { board } = await assertBoardAccess(principal.userId, boardId)
    const db = useNeon()

    const [groups, items, columns, assignRows, members] = await Promise.all([
      db.select().from(schema.groups)
        .where(eq(schema.groups.boardId, boardId))
        .orderBy(asc(schema.groups.position)),
      db.select().from(schema.items)
        .where(includeArchived
          ? eq(schema.items.boardId, boardId)
          : and(eq(schema.items.boardId, boardId), isNull(schema.items.archivedAt)))
        .orderBy(asc(schema.items.position)),
      db.select().from(schema.boardColumns)
        .where(eq(schema.boardColumns.boardId, boardId))
        .orderBy(asc(schema.boardColumns.position)),
      db.select({ itemId: schema.itemAssignees.itemId, userId: schema.itemAssignees.userId })
        .from(schema.itemAssignees)
        .innerJoin(schema.items, eq(schema.itemAssignees.itemId, schema.items.id))
        .where(eq(schema.items.boardId, boardId)),
      db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.userId, schema.users.id))
        .where(eq(schema.workspaceMembers.workspaceId, board.workspaceId)),
    ])

    // Per-item field values.
    const itemIds = items.map(it => it.id)
    const valuesByItem: Record<number, Record<number, unknown>> = {}
    if (itemIds.length && columns.length) {
      const rows = await db.select({
        itemId: schema.itemFieldValues.itemId,
        columnId: schema.itemFieldValues.columnId,
        value: schema.itemFieldValues.value,
      })
        .from(schema.itemFieldValues)
        .where(inArray(schema.itemFieldValues.itemId, itemIds))
      for (const r of rows) (valuesByItem[r.itemId] ||= {})[r.columnId] = r.value
    }

    // Names: workspace members + any person-column-referenced users.
    const userNames = new Map<number, string>()
    for (const m of members) userNames.set(Number(m.id), displayName(m.name, m.email))
    const personIds = collectPersonUserIds(columns, valuesByItem)
    const missing = [...personIds].filter(id => !userNames.has(id))
    if (missing.length) {
      const extra = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users).where(inArray(schema.users.id, missing))
      for (const u of extra) userNames.set(Number(u.id), displayName(u.name, u.email))
    }

    const assigneesByItem: Record<number, number[]> = {}
    for (const r of assignRows) (assigneesByItem[r.itemId] ||= []).push(Number(r.userId))

    // Resolve effective due date from a 'due_date' date column if present.
    const dueCol = columns.find(c => c.kind === 'date' && c.key === 'due_date')

    const itemsByGroup: Record<number, unknown[]> = {}
    for (const it of items) {
      const vals = valuesByItem[it.id] ?? {}
      let due: string | null = iso(it.dueDate)
      if (dueCol) {
        const cv = vals[dueCol.id]
        if (typeof cv === 'string' && cv) due = iso(cv)
      }
      const assigneeIds = assigneesByItem[it.id] ?? []
      const entry = {
        id: Number(it.id),
        name: it.name,
        status: it.status,
        priority: it.priority,
        dueDate: due,
        archivedAt: iso(it.archivedAt),
        assignees: assigneeIds.map(uid => ({
          id: uid,
          name: userNames.get(uid) ?? `user:${uid}`,
          email: members.find(m => Number(m.id) === uid)?.email ?? null,
        })),
        fields: resolveItemFields(columns, vals, userNames),
      }
      ;(itemsByGroup[it.groupId] ||= []).push(entry)
    }

    return {
      board: {
        id: Number(board.id),
        name: board.name,
        slug: board.slug,
        template: board.template,
        workspaceId: Number(board.workspaceId),
      },
      columns: columns.map(c => ({
        id: Number(c.id),
        key: c.key,
        label: c.label,
        kind: c.kind,
        isPrimary: c.isPrimary === 'true',
        options: Array.isArray((c.config as { options?: unknown[] } | null)?.options)
          ? ((c.config as { options: { id?: string, label?: string, color?: string }[] }).options)
            .map(o => ({ id: o.id, label: o.label, color: o.color }))
          : undefined,
      })),
      groups: groups.map(g => ({
        id: Number(g.id),
        name: g.name,
        color: g.color,
        items: itemsByGroup[g.id] ?? [],
      })),
    }
  },
}

// ============================================================
// 4. get_item
// ============================================================
const getItem: ToolDef = {
  name: 'get_item',
  description:
    'Get one work item (task/lead/row) in full detail: its core fields, the names of its group, board '
    + 'and workspace, its assignees, resolved custom field values, all comments (with author name and '
    + 'timestamp), the last 20 activity-log entries, and attachment metadata (filename, size, mime). '
    + 'Use this to answer "tell me everything about task X" or to read the discussion on an item. '
    + 'Get an item_id from get_board, search_items, or my_tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'The item id.' },
    },
    required: ['item_id'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const itemId = reqInt(args, 'item_id')
    const { item, boardId } = await assertItemAccess(principal.userId, itemId)
    const db = useNeon()

    const [board] = await db.select({
      id: schema.boards.id,
      name: schema.boards.name,
      workspaceId: schema.boards.workspaceId,
    }).from(schema.boards).where(eq(schema.boards.id, boardId)).limit(1)
    const [workspace] = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, slug: schema.workspaces.slug })
      .from(schema.workspaces).where(eq(schema.workspaces.id, board!.workspaceId)).limit(1)
    const [group] = item.groupId
      ? await db.select({ id: schema.groups.id, name: schema.groups.name })
        .from(schema.groups).where(eq(schema.groups.id, item.groupId)).limit(1)
      : [undefined]

    const [columns, valueRows, assigneeRows, comments, activity, attachments] = await Promise.all([
      db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, boardId)).orderBy(asc(schema.boardColumns.position)),
      db.select({ columnId: schema.itemFieldValues.columnId, value: schema.itemFieldValues.value })
        .from(schema.itemFieldValues).where(eq(schema.itemFieldValues.itemId, itemId)),
      db.select({ userId: schema.itemAssignees.userId }).from(schema.itemAssignees).where(eq(schema.itemAssignees.itemId, itemId)),
      db.select({
        id: schema.itemComments.id,
        body: schema.itemComments.body,
        createdAt: schema.itemComments.createdAt,
        userName: schema.users.name,
        userEmail: schema.users.email,
      })
        .from(schema.itemComments)
        .innerJoin(schema.users, eq(schema.itemComments.userId, schema.users.id))
        .where(eq(schema.itemComments.itemId, itemId))
        .orderBy(asc(schema.itemComments.createdAt)),
      db.select().from(schema.activity).where(eq(schema.activity.itemId, itemId)).orderBy(desc(schema.activity.at)).limit(20),
      db.select({
        id: schema.itemAttachments.id,
        filename: schema.itemAttachments.filename,
        size: schema.itemAttachments.size,
        mime: schema.itemAttachments.mime,
        createdAt: schema.itemAttachments.createdAt,
      }).from(schema.itemAttachments).where(eq(schema.itemAttachments.itemId, itemId)).orderBy(desc(schema.itemAttachments.createdAt)),
    ])

    const valuesByColumnId: Record<number, unknown> = {}
    for (const r of valueRows) valuesByColumnId[r.columnId] = r.value
    const assigneeIds = assigneeRows.map(r => Number(r.userId))

    // Collect users to name: assignees, person-column refs, creator.
    const personIds = collectPersonUserIds(columns, { [itemId]: valuesByColumnId })
    const wantIds = new Set<number>([...assigneeIds, ...personIds])
    if (item.createdBy) wantIds.add(Number(item.createdBy))
    const userNames = new Map<number, string>()
    let assigneeUsers: { id: number, name: string, email: string }[] = []
    if (wantIds.size) {
      const us = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users).where(inArray(schema.users.id, [...wantIds]))
      for (const u of us) userNames.set(Number(u.id), displayName(u.name, u.email))
      assigneeUsers = us.filter(u => assigneeIds.includes(Number(u.id)))
        .map(u => ({ id: Number(u.id), name: displayName(u.name, u.email), email: u.email }))
    }

    // Effective due date from a due_date column.
    const dueCol = columns.find(c => c.kind === 'date' && c.key === 'due_date')
    let due = iso(item.dueDate)
    if (dueCol) {
      const cv = valuesByColumnId[dueCol.id]
      if (typeof cv === 'string' && cv) due = iso(cv)
    }

    return {
      item: {
        id: Number(item.id),
        name: item.name,
        status: item.status,
        priority: item.priority,
        dueDate: due,
        notes: item.notes,
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
        archivedAt: iso(item.archivedAt),
        createdBy: item.createdBy
          ? { id: Number(item.createdBy), name: userNames.get(Number(item.createdBy)) ?? null }
          : null,
      },
      board: { id: Number(board!.id), name: board!.name },
      workspace: { id: Number(workspace!.id), name: workspace!.name, slug: workspace!.slug },
      group: group ? { id: Number(group.id), name: group.name } : null,
      assignees: assigneeUsers,
      fields: resolveItemFields(columns, valuesByColumnId, userNames),
      comments: comments.map(c => ({
        id: Number(c.id),
        author: displayName(c.userName, c.userEmail),
        body: c.body,
        createdAt: iso(c.createdAt),
      })),
      activity: activity.map(a => ({
        kind: a.kind,
        payload: a.payload,
        at: iso(a.at),
      })),
      attachments: attachments.map(a => ({
        id: Number(a.id),
        filename: a.filename,
        size: a.size,
        mime: a.mime,
        createdAt: iso(a.createdAt),
      })),
    }
  },
}

// ============================================================
// 5. search_items
// ============================================================
const searchItems: ToolDef = {
  name: 'search_items',
  description:
    'Full-text-ish search over work items by name and notes (case-insensitive substring match), '
    + 'scoped to the workspaces the user belongs to. Optional filters: a single workspace slug, an exact '
    + 'status, and assigned_to_me. Returns matching items with their board, workspace, and group context. '
    + 'Use for "find the task about X" or "search for leads mentioning Y".',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for in item names and notes.' },
      workspace_slug: { type: 'string', description: 'Optional. Restrict to one workspace by slug.' },
      status: { type: 'string', description: 'Optional. Only items whose status equals this value exactly.' },
      assigned_to_me: { type: 'boolean', description: 'Optional. Only items assigned to the current user (via the built-in owner field).' },
      limit: { type: 'integer', description: 'Max results (default 25, max 100).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const query = optString(args, 'query')
    if (!query) return { items: [] }
    const slug = optString(args, 'workspace_slug')
    const status = optString(args, 'status')
    const assignedToMe = optBool(args, 'assigned_to_me') ?? false
    const limit = limitArg(args, 25, 100)

    const wsIds = await scopeWorkspaceIds(principal.userId, slug)
    if (!wsIds) return { items: [] }
    const db = useNeon()
    const like = `%${query}%`

    const conds = [
      inArray(schema.boards.workspaceId, wsIds),
      isNull(schema.items.archivedAt),
      sql`(${schema.items.name} ILIKE ${like} OR coalesce(${schema.items.notes}, '') ILIKE ${like})`,
    ]
    if (status) conds.push(eq(schema.items.status, status))

    let q = db
      .select({
        id: schema.items.id,
        name: schema.items.name,
        status: schema.items.status,
        priority: schema.items.priority,
        dueDate: schema.items.dueDate,
        boardName: schema.boards.name,
        workspaceSlug: schema.workspaces.slug,
        groupName: schema.groups.name,
      })
      .from(schema.items)
      .innerJoin(schema.boards, eq(schema.items.boardId, schema.boards.id))
      .innerJoin(schema.workspaces, eq(schema.boards.workspaceId, schema.workspaces.id))
      .leftJoin(schema.groups, eq(schema.items.groupId, schema.groups.id))
      .$dynamic()

    if (assignedToMe) {
      q = q.innerJoin(
        schema.itemAssignees,
        and(eq(schema.itemAssignees.itemId, schema.items.id), eq(schema.itemAssignees.userId, principal.userId)),
      )
    }

    const rows = await q
      .where(and(...conds))
      .orderBy(desc(schema.items.updatedAt))
      .limit(limit)

    return {
      items: rows.map(r => ({
        id: Number(r.id),
        name: r.name,
        status: r.status,
        priority: r.priority,
        dueDate: iso(r.dueDate),
        boardName: r.boardName,
        workspaceSlug: r.workspaceSlug,
        groupName: r.groupName,
      })),
    }
  },
}

// ============================================================
// 6. my_tasks  — mirrors /api/me/tasks/today + /assigned
// ============================================================

// Shared query mirroring assigned.get.ts / today.get.ts: two assignment paths
// (item_assignees + person columns) and effective status/due-date resolution.
type MyTaskRow = {
  id: number
  name: string
  status: string
  priority: string
  due_date: string | null
  board_id: number
  board_name: string
  board_slug: string
  workspace_slug: string
  group_name: string | null
}

async function fetchAssignedItems(userId: number): Promise<MyTaskRow[]> {
  const db = useNeon()
  const result = await db.execute(sql`
    WITH person_cols AS (
      SELECT id AS column_id, board_id FROM board_columns WHERE kind = 'person'
    ),
    due_date_cols AS (
      SELECT DISTINCT ON (board_id) board_id, id AS column_id
      FROM board_columns WHERE kind = 'date' AND key = 'due_date'
      ORDER BY board_id, id
    ),
    status_cols AS (
      SELECT DISTINCT ON (board_id) board_id, id AS column_id
      FROM board_columns WHERE kind = 'status' AND key = 'status'
      ORDER BY board_id, id
    ),
    candidates AS (
      SELECT i.id AS item_id
      FROM items i
      JOIN item_assignees ia ON ia.item_id = i.id
      WHERE ia.user_id = ${userId} AND i.archived_at IS NULL
      UNION
      SELECT DISTINCT i.id AS item_id
      FROM items i
      JOIN item_field_values ifv ON ifv.item_id = i.id
      JOIN person_cols pc ON pc.column_id = ifv.column_id
      WHERE ifv.value @> ${sql`${JSON.stringify([userId])}::jsonb`}
        AND i.archived_at IS NULL
    )
    SELECT
      i.id,
      i.name,
      COALESCE(
        (
          SELECT ifv3.value #>> '{}'
          FROM item_field_values ifv3
          WHERE ifv3.item_id = i.id AND ifv3.column_id = sc.column_id
            AND jsonb_typeof(ifv3.value) = 'string'
        ),
        i.status
      ) AS status,
      i.priority,
      COALESCE(
        i.due_date,
        (
          SELECT (ifv2.value #>> '{}')::timestamptz
          FROM item_field_values ifv2
          WHERE ifv2.item_id = i.id AND ifv2.column_id = dc.column_id
            AND jsonb_typeof(ifv2.value) = 'string'
        )
      ) AS due_date,
      b.id AS board_id,
      b.name AS board_name,
      b.slug AS board_slug,
      w.slug AS workspace_slug,
      g.name AS group_name
    FROM candidates c
    JOIN items i ON i.id = c.item_id
    JOIN boards b ON b.id = i.board_id
    JOIN workspaces w ON w.id = b.workspace_id
    LEFT JOIN groups g ON g.id = i.group_id
    LEFT JOIN due_date_cols dc ON dc.board_id = i.board_id
    LEFT JOIN status_cols sc ON sc.board_id = i.board_id
    ORDER BY due_date ASC NULLS LAST, i.id ASC
  `)
  const r = result as unknown as { rows?: MyTaskRow[] }
  return (r.rows ?? (result as unknown as MyTaskRow[]))
}

const myTasks: ToolDef = {
  name: 'my_tasks',
  description:
    'The current user\'s own to-dos across ALL their boards — use this for questions like '
    + '"what\'s on my plate today", "what am I working on", "what\'s overdue for me". '
    + 'Covers both assignment paths (the built-in owner field and person-type columns). '
    + 'filter: "today" = due today or overdue (parked/done items dropped); "overdue" = past due only; '
    + '"upcoming" = due after today; "assigned_all" = every live item assigned to me regardless of date. '
    + 'For the user\'s private checklist that is not on any board, use list_personal_tasks instead.',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['today', 'overdue', 'upcoming', 'assigned_all'],
        description: 'Which slice of the user\'s tasks to return.',
      },
    },
    required: ['filter'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const filter = enumArg(args, 'filter', ['today', 'overdue', 'upcoming', 'assigned_all'] as const)
    const rows = await fetchAssignedItems(principal.userId)

    const now = new Date()
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))

    const map = (r: MyTaskRow) => ({
      id: Number(r.id),
      name: r.name,
      status: r.status,
      priority: r.priority,
      dueDate: iso(r.due_date),
      boardId: Number(r.board_id),
      boardName: r.board_name,
      workspaceSlug: r.workspace_slug,
      groupName: r.group_name,
    })

    let out
    if (filter === 'assigned_all') {
      // Mirror assigned.get.ts: drop parked (done/completed/hold) items.
      out = rows.filter(r => !isParked(r.status, r.group_name)).map(map)
    } else {
      // today/overdue/upcoming: bucket by effective due date, dropping parked
      // items from the dated buckets (mirrors today.get.ts semantics).
      const overdue = []
      const today = []
      const upcoming = []
      for (const r of rows) {
        if (!r.due_date) continue
        if (isParked(r.status, r.group_name)) continue
        const d = new Date(r.due_date)
        if (d < todayStart) overdue.push(r)
        else if (d <= todayEnd) today.push(r)
        else upcoming.push(r)
      }
      const pick = filter === 'overdue' ? overdue : filter === 'upcoming' ? upcoming : [...overdue, ...today]
      out = pick.map(map)
    }
    return { filter, count: out.length, tasks: out }
  },
}

// ============================================================
// 7. list_personal_tasks
// ============================================================
const listPersonalTasks: ToolDef = {
  name: 'list_personal_tasks',
  description:
    'The current user\'s PRIVATE personal checklist ("Personal List" in the sidebar) — lightweight '
    + 'to-dos not tied to any board or workspace, visible only to them. Use for "what\'s on my personal '
    + 'list" or "my private to-dos". By default returns only open (not-done) items; set include_done to '
    + 'include completed ones. For board tasks assigned to the user, use my_tasks instead.',
  inputSchema: {
    type: 'object',
    properties: {
      include_done: { type: 'boolean', description: 'Include completed items too. Defaults to false.' },
    },
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const includeDone = optBool(args, 'include_done') ?? false
    const db = useNeon()
    const rows = await db
      .select()
      .from(schema.personalTasks)
      .where(includeDone
        ? eq(schema.personalTasks.userId, principal.userId)
        : and(eq(schema.personalTasks.userId, principal.userId), isNull(schema.personalTasks.doneAt)))
      .orderBy(
        asc(schema.personalTasks.doneAt),
        sql`${schema.personalTasks.dueDate} ASC NULLS LAST`,
        asc(schema.personalTasks.position),
        asc(schema.personalTasks.id),
      )
    return {
      tasks: rows.map(r => ({
        id: Number(r.id),
        text: r.text,
        done: !!r.doneAt,
        doneAt: iso(r.doneAt),
        dueDate: r.dueDate ?? null,
        createdAt: iso(r.createdAt),
      })),
    }
  },
}

// ============================================================
// 8. get_notifications
// ============================================================
const getNotifications: ToolDef = {
  name: 'get_notifications',
  description:
    'The current user\'s notifications (the bell icon): mentions, assignments, due-soon alerts, comments, '
    + 'invite-accepted events. Each has an id, kind, payload, read state, and timestamp. '
    + 'Use for "do I have any notifications" or "what have I been mentioned in". Set unread_only to skip read ones.',
  inputSchema: {
    type: 'object',
    properties: {
      unread_only: { type: 'boolean', description: 'Only return notifications not yet read. Defaults to false.' },
      limit: { type: 'integer', description: 'Max results (default 30, max 100).' },
    },
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const unreadOnly = optBool(args, 'unread_only') ?? false
    const limit = limitArg(args, 30, 100)
    const db = useNeon()
    const rows = await db
      .select({
        id: schema.notifications.id,
        kind: schema.notifications.kind,
        payload: schema.notifications.payload,
        readAt: schema.notifications.readAt,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      .where(unreadOnly
        ? and(eq(schema.notifications.userId, principal.userId), isNull(schema.notifications.readAt))
        : eq(schema.notifications.userId, principal.userId))
      .orderBy(desc(schema.notifications.id))
      .limit(limit)
    return {
      notifications: rows.map(n => ({
        id: Number(n.id),
        kind: n.kind,
        payload: n.payload,
        readAt: iso(n.readAt),
        createdAt: iso(n.createdAt),
      })),
    }
  },
}

// ============================================================
// 9. get_board_activity
// ============================================================
const getBoardActivity: ToolDef = {
  name: 'get_board_activity',
  description:
    'Recent activity-log entries for one board (status changes, item creation, moves, etc.), newest first, '
    + 'with the acting user\'s name resolved. Use for "what happened recently on board X" or "who changed what". '
    + 'Get a board_id from list_boards.',
  inputSchema: {
    type: 'object',
    properties: {
      board_id: { type: 'integer', description: 'The board id.' },
      limit: { type: 'integer', description: 'Max entries (default 30, max 100).' },
    },
    required: ['board_id'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const boardId = reqInt(args, 'board_id')
    const limit = limitArg(args, 30, 100)
    await assertBoardAccess(principal.userId, boardId)
    const db = useNeon()
    const rows = await db
      .select({
        id: schema.activity.id,
        kind: schema.activity.kind,
        payload: schema.activity.payload,
        at: schema.activity.at,
        itemId: schema.activity.itemId,
        userId: schema.activity.userId,
        userName: schema.users.name,
        userEmail: schema.users.email,
      })
      .from(schema.activity)
      .leftJoin(schema.users, eq(schema.activity.userId, schema.users.id))
      .where(eq(schema.activity.boardId, boardId))
      .orderBy(desc(schema.activity.at))
      .limit(limit)
    return {
      activity: rows.map(a => ({
        id: Number(a.id),
        kind: a.kind,
        payload: a.payload,
        at: iso(a.at),
        itemId: a.itemId ? Number(a.itemId) : null,
        user: a.userId ? { id: Number(a.userId), name: displayName(a.userName, a.userEmail ?? '') } : null,
      })),
    }
  },
}

// ============================================================
// 10. list_members
// ============================================================
const listMembers: ToolDef = {
  name: 'list_members',
  description:
    'List the members of a workspace the user belongs to: user id, name, email, and role. '
    + 'Use this to find the user id of a teammate — e.g. before assigning a task to someone by name, '
    + 'or to answer "who is on the <workspace> team". Provide the workspace_slug from list_workspaces.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_slug: { type: 'string', description: 'The workspace slug (from list_workspaces).' },
    },
    required: ['workspace_slug'],
    additionalProperties: false,
  },
  requiredScope: 'read',
  async handler(args, principal) {
    const slug = optString(args, 'workspace_slug')
    if (!slug) return { members: [] }
    const { workspace } = await assertWorkspaceAccess(principal.userId, slug)
    const db = useNeon()
    const rows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.workspaceMembers.userId, schema.users.id))
      .where(eq(schema.workspaceMembers.workspaceId, workspace.id))
      .orderBy(asc(schema.users.name))
    return {
      workspace: { id: Number(workspace.id), slug: workspace.slug, name: workspace.name },
      members: rows.map(m => ({
        id: Number(m.id),
        name: m.name,
        email: m.email,
        role: m.role,
      })),
    }
  },
}

export const readTools: ToolDef[] = [
  listWorkspaces,
  listBoards,
  getBoard,
  getItem,
  searchItems,
  myTasks,
  listPersonalTasks,
  getNotifications,
  getBoardActivity,
  listMembers,
]
