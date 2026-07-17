# Snappi MCP Server

The [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants — **Claude** (claude.ai, Claude Code, Claude API) and **ChatGPT** — connect to [Snappi](https://snappi.now), read your boards, tasks and bugs, and update them on your behalf.

This is the production MCP layer extracted from the Snappi codebase (a Nuxt 3 / Nitro app). It is published as a **reference implementation** of a full remote MCP server with OAuth 2.1 — the pieces here show how to build:

- A **stateless Streamable-HTTP MCP endpoint** (hand-rolled JSON-RPC, no SDK dependency)
- **19 tools** (10 read, 9 write) over a real multi-tenant database, with per-tool JSON Schema
- **Bearer-token auth** with hashed-at-rest personal access tokens and `read` / `write` scopes
- A complete **OAuth 2.1 authorization server** for MCP connectors: RFC 8414 + RFC 9728 discovery metadata, RFC 7591 dynamic client registration, PKCE S256 (only), single-use auth codes, refresh-token rotation that revokes the prior access token, narrow-only scope on refresh
- **Tenant isolation**: every tool call is gated by the token owner's workspace memberships

## Layout

```
server/routes/mcp.post.ts        JSON-RPC endpoint (initialize / tools/list / tools/call)
server/mcp/registry.ts           Tool registry (ToolDef type, scope per tool)
server/mcp/access.ts             Workspace-membership permission gates
server/mcp/tools-read.ts         10 read tools (boards, items, my_tasks, search, …)
server/mcp/tools-write.ts        9 write tools (create/update items, comments, assign, …)
server/mcp/validate.ts           Argument coercion / validation helpers
server/mcp/resolve.ts            Field-value resolution (option ids → labels, person ids → names)
server/utils/api-token.ts        Mint / read / revoke personal access tokens (sha256 at rest)
server/utils/oauth.ts            OAuth 2.1 AS helpers (PKCE, auth codes, refresh rotation)
server/routes/.well-known/       OAuth discovery metadata (RFC 8414 / RFC 9728)
server/api/oauth/                register (DCR), authorize-decision, token endpoints
server/api/me/api-tokens/        Personal-token management API (session-authed)
pages/oauth/authorize.vue        The "Authorize" consent page
pages/settings/ai-connections.vue  Token-management settings UI
db/                              Drizzle schema excerpt + SQL migration for the two tables
docs/SNAPPI-MCP-SERVER.md        Full reference: tool catalog, auth flows, troubleshooting
```

## Connecting (to the hosted Snappi instance)

- **claude.ai** — Settings → Connectors → Add custom connector → `https://app.snappi.now/mcp` → sign in → Authorize
- **Claude Code** — `claude mcp add --transport http snappi https://app.snappi.now/mcp --header "Authorization: Bearer <token>"` (token from Settings → AI Connections)
- **ChatGPT** — Settings → Connectors → Advanced → Developer mode → Add MCP server → `https://app.snappi.now/mcp` → Authorize

See [docs/SNAPPI-MCP-SERVER.md](docs/SNAPPI-MCP-SERVER.md) for the complete tool catalog and security model.

## Running it yourself

This repo is **not a standalone package** — the files assume the surrounding Snappi app: Nuxt 3 with the Nitro `node-server` preset, Drizzle ORM on Postgres, a Postgres-backed KV helper (`useKV()`), and session utilities (`readSession`, `randomToken`, `sha256Hex` in `server/utils/auth.ts`). To adapt it:

1. Drop `server/mcp/`, `server/routes/mcp.*` and `server/utils/api-token.ts` into a Nitro/Nuxt app.
2. Create the `api_tokens` and `oauth_clients` tables (`db/migrations/`).
3. Replace the queries in `tools-read.ts` / `tools-write.ts` and the membership checks in `access.ts` with your own domain model — the endpoint, registry, validation and OAuth layers are domain-agnostic.
4. Point the `BASE` constant in `server/utils/oauth.ts` at your public origin.

## Security notes

- Raw tokens (`snappi_…`) are shown exactly once; only the SHA-256 hash is stored.
- Every tool handler resolves the caller from the token, never from arguments, and checks workspace membership before touching a row.
- OAuth: public clients only, PKCE S256 required, codes are single-use with a 10-minute TTL, refresh rotation invalidates both the old refresh **and** the old access token, and a refresh can never widen the originally granted scope.
- Independently reviewed against cross-tenant leakage, IDOR, open-redirect, PKCE bypass and scope-escalation before release.

## License

[MIT](LICENSE)
