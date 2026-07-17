export const apiTokens = pgTable('api_tokens', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),           // sha256 hex of the raw token
  tokenPrefix: text('token_prefix').notNull(),                // first 12 chars of raw token, for display
  scopes: jsonb('scopes').default(sql`'["read","write"]'::jsonb`),
  clientInfo: jsonb('client_info').default(sql`'{}'::jsonb`), // {via:'manual'} | {via:'oauth',clientId,clientName}
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser: index('api_tokens_user_idx').on(t.userId),
}))

// OAuth clients that can request tokens on a user's behalf (MCP OAuth flow).
// `clientSecretHash` is null for public clients (PKCE-only).
export const oauthClients = pgTable('oauth_clients', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMembers),
  assignments: many(itemAssignees),
}))

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  members: many(workspaceMembers),
  boards: many(boards),
  owner: one(users, { fields: [workspaces.ownerUserId], references: [users.id] }),
}))

export const boardsRelations = relations(boards, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [boards.workspaceId], references: [workspaces.id] }),
  groups: many(groups),
  items: many(items),
}))

export const groupsRelations = relations(groups, ({ one, many }) => ({
  board: one(boards, { fields: [groups.boardId], references: [boards.id] }),
  items: many(items),
}))

export const itemsRelations = relations(items, ({ one, many }) => ({
  board: one(boards, { fields: [items.boardId], references: [boards.id] }),
  group: one(groups, { fields: [items.groupId], references: [groups.id] }),
  assignees: many(itemAssignees),
  fieldValues: many(itemFieldValues),
}))

export const boardColumnsRelations = relations(boardColumns, ({ one, many }) => ({
  board: one(boards, { fields: [boardColumns.boardId], references: [boards.id] }),
  values: many(itemFieldValues),
}))

export const itemFieldValuesRelations = relations(itemFieldValues, ({ one }) => ({
  item: one(items, { fields: [itemFieldValues.itemId], references: [items.id] }),
  column: one(boardColumns, { fields: [itemFieldValues.columnId], references: [boardColumns.id] }),
}))

export const boardFormsRelations = relations(boardForms, ({ one, many }) => ({
  board: one(boards, { fields: [boardForms.boardId], references: [boards.id] }),
  targetGroup: one(groups, { fields: [boardForms.targetGroupId], references: [groups.id] }),
  submissions: many(boardFormSubmissions),
}))

export const itemAssigneesRelations = relations(itemAssignees, ({ one }) => ({
  item: one(items, { fields: [itemAssignees.itemId], references: [items.id] }),
  user: one(users, { fields: [itemAssignees.userId], references: [users.id] }),
}))
