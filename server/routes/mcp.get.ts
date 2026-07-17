// GET /mcp — we do NOT support the SSE server-stream leg of Streamable HTTP;
// this is a stateless POST-only tools server. Return 405 with the same CORS
// headers so a probing client gets a clean answer.

export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, 'origin')
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  })
  setResponseStatus(event, 405)
  return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: SSE not supported, POST only' }, id: null }
})
