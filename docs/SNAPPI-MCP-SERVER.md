# Snappi — MCP Server Reference

> The definitive reference for Snappi's Model Context Protocol (MCP) server: connecting Claude, ChatGPT, and other AI assistants to your boards, tasks, and data.

**Contents**

1. [Overview](#1-overview)
2. [Quick Start](#2-quick-start)
   - [claude.ai (web / desktop)](#21-claudeai-web--desktop)
   - [Claude Code](#22-claude-code)
   - [Claude API / SDK](#23-claude-api--sdk)
   - [ChatGPT](#24-chatgpt)
3. [Tool Catalog](#3-tool-catalog)
   - [Read tools](#31-read-tools)
   - [Write tools](#32-write-tools)
   - [Worked examples](#33-worked-examples)
4. [Auth & Security Model](#4-auth--security-model)
5. [Endpoints Reference](#5-endpoints-reference)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Overview

Snappi exposes a **Streamable HTTP MCP server** at:

```
https://app.snappi.now/mcp
```

The endpoint accepts **POST-only JSON-RPC 2.0** requests. It is a stateless, tools-only server (no SSE, no session state). Protocol versions `2025-06-18`, `2025-03-26`, and `2024-11-05` are accepted; unrecognised versions fall back to `2025-03-26`.

The server exposes **19 tools** (10 read, 9 write) covering workspaces, boards, items, comments, assignments, personal tasks, notifications, and activity. Every call is scoped to the authenticated user's workspace memberships — no board or item is reachable without a membership check.

### Two authentication paths

| Path | Best for | How tokens are issued |
|---|---|---|
| **OAuth (browser authorize flow)** | claude.ai connectors, ChatGPT connectors | User clicks Authorize on the Snappi consent page; the connector handles the token exchange automatically |
| **Personal access tokens** | Claude Code, direct API calls, scripts | User creates a token at **Settings → AI Connections** and copies it once |

Both paths produce a `Bearer` token sent in the `Authorization` header. The token format is `snappi_` followed by a 32-byte random string. Tokens are stored as SHA-256 hashes — the raw value is shown to you exactly once.

---

## 2. Quick Start

### 2.1 claude.ai (web / desktop)

1. Open **claude.ai** and go to **Settings → Integrations** (or **Connectors**, depending on your plan).
2. Click **Add custom connector** (or **Add MCP server**).
3. Enter the server URL: `https://app.snappi.now/mcp`
4. Save. claude.ai will open a Snappi authorization page in your browser.
5. Sign in to Snappi (if not already signed in), then click **Authorize**.
6. The connector is now active. Try: *"List my workspaces in Snappi"*.

The OAuth flow handles all token exchange automatically. Tokens are valid for 90 days; claude.ai will refresh them silently using the refresh token.

### 2.2 Claude Code

**Option A — personal access token (recommended for local dev)**

1. In Snappi, go to **Settings → AI Connections**.
2. Click **New token**, give it a name, choose **Read** or **Read + Write** scope, and click **Create**.
3. Copy the token — it is shown only once.
4. Run:

```bash
claude mcp add --transport http snappi https://app.snappi.now/mcp \
  --header "Authorization: Bearer <your-token>"
```

5. The `snappi` MCP server is now available in Claude Code. Use `/mcp` to verify it is connected.

**Option B — OAuth flow via Claude Code**

Claude Code supports the MCP OAuth flow for servers that advertise authorization server metadata. Add the server without a header:

```bash
claude mcp add --transport http snappi https://app.snappi.now/mcp
```

Then run `/mcp` in Claude Code. When prompted to authenticate, follow the browser link to the Snappi consent page, sign in, and click **Authorize**. Claude Code will complete the code exchange and store the token.

### 2.3 Claude API / SDK

Pass the MCP server in `mcp_servers` when calling the Messages API:

```json
{
  "model": "claude-opus-4-5",
  "max_tokens": 4096,
  "tools": [],
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://app.snappi.now/mcp",
      "name": "snappi",
      "authorization_token": "<your-token>"
    }
  ],
  "messages": [
    { "role": "user", "content": "What boards do I have in Snappi?" }
  ]
}
```

Replace `<your-token>` with a personal access token from **Settings → AI Connections**.

### 2.4 ChatGPT

ChatGPT's custom MCP connector support requires a **ChatGPT Plus/Team/Enterprise plan** and **Developer Mode** enabled.

1. In ChatGPT, open **Settings → Connectors → Advanced settings** and enable **Developer mode**.
2. Go to **Connectors → Add connector** and select **MCP server**.
3. Enter: `https://app.snappi.now/mcp`
4. ChatGPT will redirect you to the Snappi OAuth consent page. Sign in and click **Authorize**.
5. The connector is active. Try: *"Show me my tasks in Snappi"*.

---

## 3. Tool Catalog

All tools return compact JSON. IDs are always integers. Dates are ISO 8601 strings or `null`. List results are ordered and capped as noted.

### 3.1 Read tools

All read tools require the `read` scope.

#### `list_workspaces`

List every workspace the user is a member of.

| Parameter | Type | Required | Description |
|---|---|---|---|
| _(none)_ | — | — | Takes no arguments |

Returns `{ workspaces: [{ id, slug, name, role, boardCount }] }`.

---

#### `list_boards`

List boards across all workspaces the user belongs to.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_slug` | string | No | Restrict to a single workspace by slug (from `list_workspaces`) |

Returns `{ boards: [{ id, name, slug, workspaceSlug, template, itemCount }] }`.

---

#### `get_board`

Get one board in full: metadata, column definitions (with option labels for status/dropdown columns), and all groups with their items. Each item includes id, name, status, priority, due date, assignees, and resolved custom-field values.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `board_id` | integer | Yes | The board id (from `list_boards`) |
| `include_archived` | boolean | No | Include archived items. Defaults to `false` |

---

#### `get_item`

Get one work item in full detail: core fields, group/board/workspace context, assignees, resolved custom-field values, all comments (author + timestamp), the last 20 activity-log entries, and attachment metadata.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id (from `get_board`, `search_items`, or `my_tasks`) |

---

#### `search_items`

Case-insensitive substring search over item names and notes across all accessible workspaces.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Text to search for in item names and notes |
| `workspace_slug` | string | No | Restrict to one workspace by slug |
| `status` | string | No | Only items whose status matches this value exactly |
| `assigned_to_me` | boolean | No | Only items assigned to the current user |
| `limit` | integer | No | Max results (default 25, max 100) |

---

#### `my_tasks`

The current user's own to-dos across all boards — covers both the built-in owner field and person-type columns.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filter` | string (enum) | Yes | One of: `today` (due today or overdue, parked/done dropped), `overdue` (past due only), `upcoming` (due after today), `assigned_all` (every live item assigned to me, no date filter) |

Returns `{ filter, count, tasks: [{ id, name, status, priority, dueDate, boardId, boardName, workspaceSlug, groupName }] }`.

---

#### `list_personal_tasks`

The current user's private personal checklist ("Personal List" in the sidebar) — to-dos not tied to any board.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `include_done` | boolean | No | Include completed items. Defaults to `false` |

Returns `{ tasks: [{ id, text, done, doneAt, dueDate, createdAt }] }`.

---

#### `get_notifications`

The current user's notification inbox (mentions, assignments, due-soon alerts, comments, invite-accepted events).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `unread_only` | boolean | No | Only unread notifications. Defaults to `false` |
| `limit` | integer | No | Max results (default 30, max 100) |

Returns `{ notifications: [{ id, kind, payload, readAt, createdAt }] }`.

---

#### `get_board_activity`

Recent activity-log entries for one board (status changes, item creation, moves, etc.), newest first, with the acting user's name resolved.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `board_id` | integer | Yes | The board id (from `list_boards`) |
| `limit` | integer | No | Max entries (default 30, max 100) |

Returns `{ activity: [{ id, kind, payload, at, itemId, user }] }`.

---

#### `list_members`

List members of a workspace: user id, name, email, and role. Use this to look up a teammate's id or email before assigning a task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_slug` | string | Yes | The workspace slug (from `list_workspaces`) |

Returns `{ workspace: { id, slug, name }, members: [{ id, name, email, role }] }`.

---

### 3.2 Write tools

All write tools require the `write` scope. Tokens with only the `read` scope will receive an error response if a write tool is called.

#### `create_item`

Create a new work item (task/lead/row) on a board.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `board_id` | integer | Yes | The board id (from `list_boards`) |
| `name` | string | Yes | The item title (max 200 characters) |
| `group_id` | integer | No | Target group id (from `get_board`). Defaults to the board's first group |
| `status` | string | No | One of: `not_started`, `working_on_it`, `stuck`, `done`. Default: `not_started` |
| `priority` | string | No | One of: `low`, `medium`, `high`, `urgent`. Default: `medium` |
| `due_date` | string | No | Due date as `YYYY-MM-DD` or ISO timestamp |
| `notes` | string | No | Free-text notes/description |

Returns `{ item: { id, name, boardId, groupId, status, priority, dueDate, notes, assigneeIds, updatedAt } }`.

---

#### `update_item`

Update fields on an existing work item (partial — only pass what changes).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id |
| `name` | string | No | New title |
| `status` | string | No | New status: `not_started`, `working_on_it`, `stuck`, `done` |
| `priority` | string | No | New priority: `low`, `medium`, `high`, `urgent` |
| `due_date` | string | No | New due date (`YYYY-MM-DD` or ISO). Empty string clears it |
| `notes` | string | No | New notes (max 2000 characters) |
| `group_id` | integer | No | Move the item to this group (must be on the same board) |
| `archived` | boolean | No | `true` archives the item; `false` restores it |

At least one field is required. Returns `{ item: ... }` (same shape as `create_item`).

---

#### `set_field_value`

Set one custom column value on an item, addressed by the column's stable key (from `get_board`'s `columns[].key`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id |
| `column_key` | string | Yes | The column key (from `get_board columns[].key`) |
| `value` | any | No | Value to store. Type depends on column kind (see below). `null` clears the field |

Value types by column kind:

| Column kind | Accepted value |
|---|---|
| `status`, `dropdown` | Option id or case-insensitive option label |
| `multi_select` | Array of option ids or labels |
| `person` | Array of user ids (integers) or member email addresses |
| `number`, `currency`, `rating` | Number |
| `date` | `YYYY-MM-DD` or ISO timestamp |
| `text`, `long_text`, `email`, `phone`, `url` | String |

Returns `{ column: { id, key, label, kind }, storedValue, movedToGroupId }`. When a status column value matches a group name on the same board, the item is automatically moved to that group (mirroring the board UI's status-to-group automation).

---

#### `add_comment`

Post a comment on a work item as the current user. Notifies the item's assignees (except the author). Supports `@username` mentions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id to comment on |
| `body` | string | Yes | The comment text (max 8000 characters) |

Returns `{ comment: { id, createdAt } }`.

---

#### `assign_item`

Add or remove an assignee (the built-in owner field) on a work item. Adding notifies the assigned user.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id |
| `user` | integer or string | Yes | User id (integer) or email address of a workspace member |
| `action` | string (enum) | Yes | `add` or `remove` |

Returns `{ itemId, assignees: [{ id, name, email }] }` (the full current assignee list after the change).

---

#### `move_item`

Move a work item to a different group on the same board. The target group must belong to the item's board.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item_id` | integer | Yes | The item id to move |
| `group_id` | integer | Yes | The destination group id (must be on the same board) |

Returns `{ item: ... }` (same shape as `create_item`).

---

#### `create_personal_task`

Add a to-do to the current user's private personal checklist (not tied to any board).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | Yes | The to-do text (max 500 characters) |
| `due_date` | string | No | Calendar date `YYYY-MM-DD` |

Returns `{ task: { id, text, done, dueDate, createdAt } }`.

---

#### `update_personal_task`

Edit a personal-checklist to-do owned by the current user.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer | Yes | The personal task id (from `list_personal_tasks`) |
| `text` | string | No | New to-do text |
| `due_date` | string | No | New due date `YYYY-MM-DD`. Empty string clears it |
| `done` | boolean | No | `true` marks complete; `false` reopens |

At least one of `text`, `due_date`, or `done` is required. Only the owner's own tasks are editable. Returns `{ task: { id, text, done, doneAt, dueDate, updatedAt } }`.

---

#### `delete_personal_task`

Delete a to-do from the current user's private personal checklist. Only the owner's own tasks can be deleted.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer | Yes | The personal task id (from `list_personal_tasks`) |

Returns `{ deleted: true, id }`.

---

### 3.3 Worked examples

These show how a natural-language prompt translates into tool calls.

**"What's on my plate today?"**

1. `my_tasks` with `filter: "today"` — returns overdue + due-today items across all boards.

---

**"Find the login bug and move it to Done, then tell the team."**

1. `search_items` with `query: "login bug"` — finds the item and returns its `id`.
2. `update_item` with `item_id: <id>` and `status: "done"` — marks it done.
3. `add_comment` with `item_id: <id>` and a message — posts an update visible to the team.

---

**"Assign the Q3 roadmap task to alice@example.com and set it to high priority."**

1. `search_items` with `query: "Q3 roadmap"` — locates the item.
2. `assign_item` with `item_id: <id>`, `user: "alice@example.com"`, `action: "add"`.
3. `update_item` with `item_id: <id>` and `priority: "high"`.

---

**"Who is on the Acme workspace team, and what are they working on?"**

1. `list_workspaces` — confirms the Acme workspace slug.
2. `list_members` with `workspace_slug: "acme"` — returns the team roster with ids.
3. `my_tasks` (or `search_items` with `assigned_to_me: true`) — shows tasks per person (run per member if needed, or use `get_board` to browse by assignee column).

---

## 4. Auth & Security Model

### Token storage and format

- Raw token format: `snappi_` + 32 random bytes (hex-encoded).
- Only a **SHA-256 hash** of the raw token is stored in the database. The raw value is shown exactly once at creation time.
- A 12-character display prefix (`snappi_XXXXXXXX`) is stored for UI display.
- Manually created tokens (from Settings → AI Connections) have **no expiry** by default.
- OAuth-issued tokens expire after **90 days** and carry a refresh token (also 90-day, single-use rotation).

### Scopes

| Scope | Grants access to |
|---|---|
| `read` | All 10 read tools. No data is written |
| `write` | All 9 write tools (requires `read` scope also to be present) |

When creating a personal access token, choose **Read** for assistants that should only answer questions, or **Read + Write** for assistants that can also create and modify items. The `write` scope alone (without `read`) is not a valid combination — personal tokens are always `['read']` or `['read', 'write']`.

### Workspace isolation

Every tool call is scoped to workspaces the token owner is a member of. Boards, items, groups, and members from workspaces the user has no membership in are invisible — lookups return empty results rather than errors.

### Token lifecycle

- **Suspension**: If the user account is suspended, all tokens for that account are immediately rejected.
- **Revocation**: Any token can be revoked instantly from **Settings → AI Connections** → click the trash icon. Revoked tokens are rejected on the next request.
- **Expiry**: OAuth tokens reject after 90 days. The connector's refresh token extends access automatically if the user re-authorizes before both tokens expire.
- **Refresh rotation**: Each time a refresh token is used to obtain a new access token, the previous access token is immediately revoked and a new refresh token is issued (single-use rotation).

### OAuth flow details

The OAuth flow follows RFC 6749 (authorization code grant) + RFC 7636 (PKCE) + RFC 7591 (dynamic client registration):

- **PKCE**: `code_challenge_method: S256` is required. Plain challenges are rejected.
- **Public clients only**: No client secret is ever issued. All clients use `token_endpoint_auth_method: none`.
- **Dynamic client registration**: Clients register themselves at `/api/oauth/register` with their `redirect_uris`. Up to 10 URIs per client. Redirect URIs must be `https://` or `http://localhost` / `http://127.0.0.1`.
- **Auth codes**: Single-use, 10-minute TTL, stored in KV.
- **Access tokens**: 90-day TTL (`expires_in: 7776000`).
- **Refresh tokens**: 90-day TTL, single-use rotation.
- **Scopes negotiated**: The `scope` in the authorize request is honoured. Refresh requests may narrow but never widen the originally granted scope.

---

## 5. Endpoints Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `https://app.snappi.now/mcp` | POST | MCP JSON-RPC endpoint. Requires `Authorization: Bearer <token>` header. GET returns 405; OPTIONS returns 204 preflight. |
| `https://app.snappi.now/.well-known/oauth-authorization-server` | GET | RFC 8414 authorization server metadata (issuer, authorization/token/registration endpoints, supported scopes, PKCE methods). |
| `https://app.snappi.now/.well-known/oauth-protected-resource` | GET | RFC 9728 protected resource metadata. Points MCP clients to the authorization server. |
| `https://app.snappi.now/api/oauth/register` | POST | RFC 7591 dynamic client registration. No auth required. Rate-limited to 10 registrations/hour/IP. |
| `https://app.snappi.now/oauth/authorize` | GET | Browser-facing consent page. Requires an active Snappi session. Presents the app name and scope for user approval. |
| `https://app.snappi.now/api/oauth/token` | POST | Token endpoint. Accepts `application/x-www-form-urlencoded` or JSON. Supports `authorization_code` and `refresh_token` grant types. |

CORS is open on all MCP and OAuth endpoints — connector clients from any origin can reach them.

---

## 6. Troubleshooting

**401 Unauthorized**

The token is missing, has the wrong format, has been revoked, has expired, or the account is suspended.
- Regenerate a new token at **Settings → AI Connections**.
- For OAuth connectors: reconnect by going through the authorize flow again.
- Confirm the header is exactly `Authorization: Bearer snappi_...` with no extra whitespace.

**"this API token does not have the 'write' scope"**

The token was created with read-only scope. Either create a new token with **Read + Write** scope, or use the OAuth flow and request the `write` scope during authorization.

**"Board X not found" / empty results**

The token owner is not a member of that workspace. Access in Snappi is always tied to workspace membership — there is no way to grant an AI assistant access to a board the user cannot see themselves.

**"Group N does not belong to this item's board"**

When calling `move_item`, `create_item` with a `group_id`, or `update_item` with a `group_id`, the group must be on the same board as the item. Use `get_board` to list the correct group ids.

**"No column with key X on this board"**

Column keys are board-specific. The error message includes the available keys. Retrieve them with `get_board` and check `columns[].key`.

**ChatGPT connector not appearing**

Custom MCP connectors in ChatGPT require a **Plus, Team, or Enterprise plan** with **Developer mode** enabled in Settings → Advanced settings. Standard free-tier accounts do not have access to the Connectors panel.

**CORS errors in browser-based scripts**

CORS is fully open on the `/mcp` endpoint and all OAuth endpoints (`Access-Control-Allow-Origin: *` with request-origin reflection). If you see a CORS error, the request is likely missing the `Authorization` header (which triggers a 401 before CORS headers are set on some clients) or is hitting a non-existent path.

**Batch requests rejected**

The MCP specification revision 2025-06-18 removed JSON-RPC batch support. Snappi follows this — sending an array body returns `"Batch requests are not supported"`. Send one request at a time.
