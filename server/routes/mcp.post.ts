// Stateless Streamable-HTTP MCP endpoint (JSON-RPC 2.0 over POST).
//
// Hand-rolled — no @modelcontextprotocol/sdk. A tools-only, stateless server
// is simple: we parse a single JSON-RPC request (batching is rejected per the
// 2025-06-18 spec) and dispatch it. There is no session state, no SSE — just
// request/response. GET (SSE) is 405 (mcp.get.ts) and OPTIONS is 204 preflight
// (mcp.options.ts).
//
// Auth is via a Snappi API token in the Authorization header (Bearer). On a
// missing/invalid token we return 401 with a WWW-Authenticate header pointing
// at the OAuth protected-resource metadata, so an MCP client can discover how
// to obtain a token.

import { readApiToken, type ApiTokenPrincipal } from '~~/server/utils/api-token'
import { tools, findTool } from '~~/server/mcp/registry'

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL_VERSION = '2025-03-26'
const RESOURCE_METADATA_URL = 'https://app.snappi.now/.well-known/oauth-protected-resource'

type JsonRpcId = string | number | null

function setCors(event: any) {
  const origin = getRequestHeader(event, 'origin')
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Vary': 'Origin',
  })
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, error: { code, message, ...(data !== undefined ? { data } : {}) }, id }
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, result, id }
}

export default defineEventHandler(async (event) => {
  setCors(event)
  setResponseHeader(event, 'Content-Type', 'application/json')

  // ---- Auth ----
  const principal = await readApiToken(getRequestHeader(event, 'authorization'))
  if (!principal) {
    setResponseStatus(event, 401)
    setResponseHeader(event, 'WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`)
    return rpcError(null, -32001, 'Unauthorized')
  }

  // ---- Parse body ----
  let body: unknown
  try {
    body = await readBody(event)
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }

  // Batching removed in 2025-06-18 — reject arrays.
  if (Array.isArray(body)) {
    return rpcError(null, -32600, 'Batch requests are not supported')
  }
  if (!body || typeof body !== 'object') {
    return rpcError(null, -32600, 'Invalid Request')
  }

  const req = body as { jsonrpc?: unknown, method?: unknown, params?: unknown, id?: unknown }
  const method = typeof req.method === 'string' ? req.method : ''
  const params = (req.params ?? {}) as Record<string, unknown>
  const hasId = 'id' in req && req.id !== undefined
  const id = (hasId ? req.id : null) as JsonRpcId

  // A request without an id (and not a recognised notification) is treated as
  // a notification: acknowledge with 202 and no body.
  const isNotification = !hasId || method.startsWith('notifications/')

  // ---- Notifications ----
  if (method.startsWith('notifications/')) {
    setResponseStatus(event, 202)
    return null
  }

  // ---- Dispatch ----
  switch (method) {
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)
        ? clientVersion
        : DEFAULT_PROTOCOL_VERSION
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'snappi', title: 'Snappi', version: '1.0.0' },
        instructions:
          'Snappi is a Monday.com-style work OS. These tools read the signed-in user\'s workspaces, '
          + 'boards, work items, tasks, comments, notifications, and activity. Start with list_workspaces '
          + 'and list_boards to discover ids, then get_board / get_item for detail. Use my_tasks for the '
          + 'user\'s own to-dos and search_items to find things by text.',
      })
    }

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list': {
      return rpcResult(id, {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    }

    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : ''
      const rawArgs = (params.arguments ?? {}) as Record<string, unknown>
      const tool = findTool(toolName)
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${toolName || '(none)'}`)
      }
      // Scope enforcement: the token must carry the tool's required scope.
      if (!principalHasScope(principal, tool.requiredScope)) {
        return rpcResult(id, {
          content: [{
            type: 'text',
            text: `Error: this API token does not have the "${tool.requiredScope}" scope required to call ${tool.name}. `
              + `Token scopes: [${principal.scopes.join(', ') || 'none'}].`,
          }],
          isError: true,
        })
      }
      try {
        const result = await tool.handler(rawArgs, principal)
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
        })
      } catch (err: any) {
        const message = err?.message ? String(err.message) : 'tool execution failed'
        return rpcResult(id, {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        })
      }
    }

    default: {
      if (isNotification) {
        setResponseStatus(event, 202)
        return null
      }
      return rpcError(id, -32601, `Method not found: ${method || '(none)'}`)
    }
  }
})

function principalHasScope(principal: ApiTokenPrincipal, scope: 'read' | 'write'): boolean {
  return Array.isArray(principal.scopes) && principal.scopes.includes(scope)
}
