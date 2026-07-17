// OPTIONS /mcp — CORS preflight. MCP clients (browser-hosted or the Claude/
// ChatGPT connectors) send this before the real POST; it MUST succeed.

export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, 'origin')
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  })
  setResponseStatus(event, 204)
  return null
})
